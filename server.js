import { Hono } from "https://deno.land/x/hono/mod.ts";
import { serveStatic } from "https://deno.land/x/hono/middleware.ts";
import { getCookie, setCookie } from "https://deno.land/x/hono/helper/cookie/index.ts";
import { SignJWT, jwtVerify } from "https://deno.land/x/jose@v5.2.0/index.ts";

const app = new Hono();
const PORT = 3000;

// Load credentials from the local creds file as fallback
async function loadCredsFile(path) {
  try {
    const file = await Deno.readTextFile(path);
    return Object.fromEntries(
      file.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key.trim(), rest.join("=").trim()];
        })
    );
  } catch {
    return {};
  }
}

const CREDS = await loadCredsFile("./creds");
function getEnv(key, fallback = "") {
  return Deno.env.get(key) || CREDS[key] || fallback;
}

// JWT Configuration
const JWT_SECRET = getEnv("JWT_SECRET", "your-super-secret-jwt-key-change-this-in-production");
const JWT_EXPIRATION = 60; // 60 seconds

// GitHub OAuth configuration
const GITHUB_CLIENT_ID = getEnv("GITHUB_CLIENT_ID");
const GITHUB_CLIENT_SECRET = getEnv("GITHUB_CLIENT_SECRET");
const BASE_URL = getEnv("BASE_URL", `http://localhost:${PORT}`);
const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const LOCAL_GITHUB_TEST = !GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET;

function generateOAuthState() {
  return crypto.randomUUID();
}

function getGitHubAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${BASE_URL}/auth/github/callback`,
    scope: "read:user user:email",
    state,
    allow_signup: "true"
  });

  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

async function fetchGitHubUser(accessToken) {
  const userResponse = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json"
    }
  });

  if (!userResponse.ok) {
    throw new Error(`GitHub /user request failed: ${userResponse.status}`);
  }

  const userData = await userResponse.json();
  return userData;
}

async function fetchGitHubEmail(accessToken) {
  const emailResponse = await fetch(GITHUB_EMAILS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json"
    }
  });

  if (!emailResponse.ok) {
    throw new Error(`GitHub /user/emails request failed: ${emailResponse.status}`);
  }

  const emailData = await emailResponse.json();
  const primary = emailData.find((item) => item.primary && item.verified);
  const fallback = emailData.find((item) => item.verified);
  return primary?.email || fallback?.email || null;
}

// Helper function to create JWT
async function createJWT(payload) {
  const secret = new TextEncoder().encode(JWT_SECRET);
  const now = Date.now() / 1000;
  
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRATION)
    .sign(secret);
    
  return jwt;
}

// Helper function to verify JWT
async function verifyJWT(token) {
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    
    // Check if token is expired
    const now = Date.now() / 1000;
    if (payload.exp && payload.exp < now) {
      return null;
    }
    
    return payload;
  } catch (error) {
    return null;
  }
}

// Middleware to verify JWT
function requireAuth(c, next) {
  return async (c) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.replace("Bearer ", "") || getCookie(c, "token");
    
    if (!token) {
      return c.json({ error: "No token provided" }, 401);
    }
    
    const payload = await verifyJWT(token);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    
    c.set("user", payload);
    await next();
  };
}

// Root route
app.get("/", async (c) => {
  const token = getCookie(c, "token");
  
  if (token) {
    const payload = await verifyJWT(token);
    if (payload) {
      return c.redirect("/dashboard.html", 302);
    }
  }
  
  return c.redirect("/login.html", 302);
});

// Login page
app.get("/login.html", async (c) => {
  try {
    const html = await Deno.readTextFile("./public/login.html");
    return c.html(html);
  } catch {
    return c.text("Login page not found", 404);
  }
});

// Start GitHub OAuth flow
app.get("/auth/github", (c) => {
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    return c.text("GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.", 500);
  }

  const state = generateOAuthState();
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: 300
  });

  return c.redirect(getGitHubAuthUrl(state), 302);
});

// GitHub OAuth callback
app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  if (!code || !state || state !== storedState) {
    return c.text("Invalid OAuth state or missing code.", 400);
  }

  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}/auth/github/callback`
    })
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    return c.text(`GitHub token exchange failed: ${tokenData.error_description || tokenData.error || "missing access_token"}`, 500);
  }

  let githubUser;
  try {
    githubUser = await fetchGitHubUser(tokenData.access_token);
  } catch (error) {
    console.error("GitHub user fetch failed:", error);
    return c.text("Failed to fetch GitHub user information.", 500);
  }

  let email = githubUser.email;
  if (!email) {
    try {
      email = await fetchGitHubEmail(tokenData.access_token);
    } catch (error) {
      console.warn("GitHub email fetch failed:", error);
    }
  }

  const payload = {
    username: githubUser.login || githubUser.id,
    fullName: githubUser.name || githubUser.login || githubUser.id,
    email: email || `${githubUser.login || githubUser.id}@users.noreply.github.com`,
    role: "github-user",
    picture: githubUser.avatar_url || ""
  };

  const token = await createJWT(payload);
  setCookie(c, "token", token, {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: JWT_EXPIRATION
  });
  setCookie(c, "oauth_state", "", {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: 0
  });

  return c.redirect("/dashboard.html", 302);
});

// Dashboard (protected route)
app.get("/dashboard.html", async (c) => {
  const token = getCookie(c, "token");
  
  if (!token) {
    return c.redirect("/login.html", 302);
  }
  
  const payload = await verifyJWT(token);
  if (!payload) {
    return c.redirect("/login.html", 302);
  }
  
  try {
    const html = await Deno.readTextFile("./public/dashboard.html");
    return c.html(html);
  } catch {
    return c.text("Dashboard not found", 404);
  }
});

// API to get current user info
app.get("/api/user", async (c) => {
  const token = getCookie(c, "token");
  
  if (!token) {
    return c.json({ error: "No token provided" }, 401);
  }
  
  const payload = await verifyJWT(token);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  
  return c.json(payload);
});

// Logout
app.post("/logout", (c) => {
  setCookie(c, "token", "", {
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
    maxAge: 0
  });

  return c.redirect("/login.html", 302);
});

// Middleware to serve static files (after all API routes)
app.use("/*", serveStatic({ root: "./public" }));

// Start server
console.log(`🚀 Server is running on http://localhost:${PORT}`);
console.log("\nThis app uses GitHub Identity Provider to authenticate users and then issues a local JWT session token.");
console.log("   - GitHub OAuth login via /auth/github");
console.log("   - Tokens expire in 60 seconds");
console.log("   - Stored in HTTP-only cookies");
console.log("   - Stateless authentication\n");

Deno.serve({ port: PORT }, (req) => {
  return app.fetch(req);
});
