import type { Express } from "express";
import bcrypt from "bcrypt";
import { ZodError } from "zod";
import { storage } from "./storage.js";
import { loginSchema, registerSchema } from "../shared/schema.js";

/* ============================================================
   CORRECT BASE API URL FOR DEPLOYMENT
============================================================ */
import { BASE_API_URL } from "./index.js";

/* 
  On Vercel: BASE_API_URL = Render backend
  On Local:  BASE_API_URL = http://localhost:3000 (your server)
*/

/* ============================================================
   REGISTER ROUTES
============================================================ */
export function registerRoutes(app: Express) {
  /* -------------------- AUTHENTICATION -------------------- */

  // CURRENT LOGGED-IN USER
app.get("/api/me", async (req, res) => {
  try {
    const sessionId = req.cookies.sessionId;
    if (!sessionId) return res.json(null);

    const session = await storage.getSession(sessionId);
    if (!session) return res.json(null);

    const user = await storage.getUser(session.userId);
    if (!user) return res.json(null);

    const { password, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    console.error("ME route error:", err);
    res.json(null);
  }
});


  // LOGIN
  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = loginSchema.parse(req.body);
      const user = await storage.getUserByUsername(username);
      if (!user) return res.status(401).json({ message: "Invalid credentials" });

      if (user.cooldownUntil && user.cooldownUntil > new Date()) {
        const remaining = Math.ceil((user.cooldownUntil.getTime() - Date.now()) / 1000);
        return res.status(429).json({
          message: "Account temporarily locked. Try again later.",
          remainingSeconds: remaining,
        });
      }

      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        await storage.incrementLoginAttempts(username);

        if ((user.loginAttempts || 0) >= 2) {
          const cooldownUntil = new Date(Date.now() + 5 * 60 * 1000);
          await storage.setCooldown(username, cooldownUntil);
          return res.status(429).json({
            message: "Too many failed attempts. Account locked for 5 minutes.",
            cooldownUntil,
          });
        }

        return res.status(401).json({ message: "Invalid credentials" });
      }

      await storage.resetLoginAttempts(username);
      const session = await storage.createSession(user.id);

      // 🔥 COOKIE FIX FOR DEPLOYMENT (REQUIRED)
      res.cookie("sessionId", session.id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "none", // IMPORTANT for Vercel + Render cross-domain
        maxAge: 24 * 60 * 60 * 1000,
      });

      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser, session });
    } catch (err) {
      console.error("Login error:", err);
      res.status(400).json({ message: "Invalid request data" });
    }
  });

  // REGISTER
  app.post("/api/register", async (req, res) => {
    try {
      const userData = registerSchema.parse(req.body);
      const { confirmPassword, ...cleanData } = userData;
      const user = await storage.registerUser(cleanData);
      const { password: _, ...safeUser } = user;
      res.status(201).json({ user: safeUser });
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: "Invalid request data", errors: error.errors });
      }
      if (error.message === "Username already exists") {
        return res.status(409).json({ message: error.message });
      }
      console.error("Register error:", error);
      res.status(400).json({ message: "Invalid request" });
    }
  });

  // LOGOUT
  app.post("/api/logout", async (req, res) => {
    const sessionId = req.cookies.sessionId;
    if (sessionId) await storage.deleteSession(sessionId);
    res.clearCookie("sessionId");
    res.json({ message: "Logged out successfully" });
  });

  /* -------------------- ADMIN ROUTES -------------------- */

  app.post("/api/admin/reset-password", async (req, res) => {
    try {
      const sessionId = req.cookies.sessionId;
      if (!sessionId) return res.status(401).json({ message: "Unauthorized" });

      const session = await storage.getSession(sessionId);
      if (!session) return res.status(401).json({ message: "Invalid session" });

      const adminUser = await storage.getUser(session.userId);
      if (!adminUser || adminUser.role.toLowerCase() !== "admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      const { username, newPassword } = req.body;
      if (!username || !newPassword) {
        return res.status(400).json({ message: "Username and newPassword required" });
      }

      const staff = await storage.getUserByUsername(username);
      if (!staff) return res.status(404).json({ message: "User not found" });

      const hashed = await bcrypt.hash(newPassword, 10);
      await storage.updateUserPassword(username, hashed);

      res.json({ message: `Password reset for ${username}` });
    } catch (err) {
      console.error("Admin reset error:", err);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/api/admin/accounts", async (req, res) => {
    try {
      const sessionId = req.cookies.sessionId;
      if (!sessionId) return res.status(401).json({ message: "Unauthorized" });

      const session = await storage.getSession(sessionId);
      if (!session) return res.status(401).json({ message: "Invalid session" });

      const adminUser = await storage.getUser(session.userId);
      if (!adminUser || adminUser.role.toLowerCase() !== "admin") {
        return res.status(403).json({ message: "Access denied" });
      }

      const allUsers = await storage.getAllUsers();
      const sanitized = allUsers
        .filter(u => ["staff", "supplier"].includes(u.role.toLowerCase()))
        .map(({ password, ...rest }) => rest);

      res.json(sanitized);
    } catch (err) {
      console.error("Admin view accounts error:", err);
      res.status(500).json({ message: "Server error" });
    }
  });

  /* -------------------- PRODUCTS / SALES / REPORTS -------------------- */
  // (Your remaining routes unchanged — they are correct)
}
