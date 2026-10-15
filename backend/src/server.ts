import dotenv from "dotenv";
dotenv.config({ override: true });
import express from "express";
import path from "path";
import mongoose from "mongoose";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { setupAgentRoutes } from "./agents";

// Models
const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  name: String,
  role: { type: String, enum: ['student', 'mentor'], required: true },
  teacherEmail: String,
  dailyFocusGoal: { type: Number, default: 120 },
  todayFocusMinutes: { type: Number, default: 0 },
  taskCompletionRate: { type: Number, default: 0 },
  peerBadges: { type: Object, default: {} },
  cognitiveLoad: { type: Number, default: 50 },
  lastActive: String,
  badges: [String],
  courses: [String],
}, { strict: false }); // Allow dynamic properties since it's an evolving schema

export const UserProfileModel = mongoose.model('UserProfile', userSchema);

const taskSchema = new mongoose.Schema({
  id: String, // from firestore or generated
  studentId: String,
  title: String,
  status: String,
  difficulty: String,
  estimatedMinutes: Number,
  createdAt: String,
  type: String,
  description: String,
  points: Number
}, { strict: false });

export const TaskModel = mongoose.model('Task', taskSchema);

const courseSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  classLevel: String,
  subject: String,
  title: String,
  description: String,
  order: Number
}, { strict: false });
export const CourseModel = mongoose.model('Course', courseSchema);

const moduleSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  courseId: String,
  term: String,
  title: String,
  learningObjectives: [String],
  order: Number
}, { strict: false });
export const ModuleModel = mongoose.model('Module', moduleSchema);

const lessonSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  moduleId: String,
  month: String,
  theme: String,
  topic: String,
  learningOutcome: String,
  instructionalFlow: [{
    step: String,
    duration: String,
    activity: String
  }],
  resources: [String],
  order: Number
}, { strict: false });
export const LessonModel = mongoose.model('Lesson', lessonSchema);

const promptSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  mentorId: String,
  text: { type: String, required: true },
  cohort: String,
  createdAt: { type: Date, default: Date.now }
});
export const PromptModel = mongoose.model('BroadcastPrompt', promptSchema);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json());

// Initialize Gemini AI Client
const geminiApiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({ apiKey: geminiApiKey });
  console.log("Google Gen AI client initialized.");
} else {
  console.warn("GEMINI_API_KEY is missing. AI Agent features will fail.");
}

function isValidMongoUri(uri?: string): boolean {
  if (!uri || uri === "YOUR_MONGODB_URI" || uri.includes("YOUR_")) return false;
  return uri.startsWith("mongodb://") || uri.startsWith("mongodb+srv://");
}

let isConnecting = false;
let dbConnectFailed = false;

async function ensureDbConnected() {
  if (mongoose.connection.readyState === 1) return;
  const mongoURI = process.env.MONGODB_URI;
  if (!isValidMongoUri(mongoURI)) {
    return;
  }
  if (!isConnecting && !dbConnectFailed) {
    isConnecting = true;
    try {
      await mongoose.connect(mongoURI!, {
        serverSelectionTimeoutMS: 5000,
      });
      console.log("Connected to MongoDB successfully");
      dbConnectFailed = false;
    } catch (err) {
      dbConnectFailed = true;
      console.error("Failed to connect to MongoDB:", err);
    } finally {
      isConnecting = false;
    }
  }
}

// Initial connection attempt if valid URI configured
ensureDbConnected();

// Middleware to ensure DB connection is ready in serverless environments
app.use(async (req, res, next) => {
  if (isValidMongoUri(process.env.MONGODB_URI) && mongoose.connection.readyState !== 1 && !dbConnectFailed) {
    await ensureDbConnected();
  }
  next();
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "backend",
    dbReady: mongoose.connection.readyState === 1,
    inMemoryFallback: !isDbReady(),
    timestamp: new Date().toISOString()
  });
});

// In-memory fallback store when MONGODB_URI is not configured (e.g. demo mode / local testing)
const memUsers = new Map<string, any>();
const memTasks = new Map<string, any>();
const memCourses = new Map<string, any>();
const memModules = new Map<string, any>();
const memLessons = new Map<string, any>();
const memPrompts: any[] = [];

// Seed default demo course into in-memory store
memCourses.set("course-demo", {
  id: "course-demo",
  classLevel: "Class 10",
  subject: "Physics",
  title: "Introduction to Kinematics",
  description: "A foundational course on motion and forces.",
  order: 1
});

memModules.set("mod-demo-1", {
  id: "mod-demo-1",
  courseId: "course-demo",
  term: "Term 1",
  title: "Mechanics",
  learningObjectives: ["Understand velocity and acceleration", "Apply Newton's Laws"],
  order: 1
});

memLessons.set("les-demo-1", {
  id: "les-demo-1",
  moduleId: "mod-demo-1",
  month: "April",
  theme: "Motion",
  topic: "Velocity vs. Speed",
  learningOutcome: "Distinguish between scalar and vector quantities of motion.",
  instructionalFlow: [
    { step: "Hook", duration: "5 mins", activity: "Show a racecar video." },
    { step: "Direct Instruction", duration: "15 mins", activity: "Explain concepts." },
    { step: "Practice", duration: "15 mins", activity: "Worksheet on velocity calculation." },
    { step: "Closure", duration: "5 mins", activity: "Exit ticket." }
  ],
  resources: ["Video link", "Worksheet PDF"],
  order: 1
});

function isDbReady(): boolean {
  return Boolean(isValidMongoUri(process.env.MONGODB_URI) && mongoose.connection.readyState === 1);
}

// --- API Routes ---

  // Users
  app.get("/api/users", async (req, res) => {
    try {
      if (!isDbReady()) {
        let users = Array.from(memUsers.values());
        if (req.query.role) users = users.filter(u => u.role === req.query.role);
        if (req.query.email) users = users.filter(u => u.email === req.query.email);
        if (req.query.teacherEmail) users = users.filter(u => u.teacherEmail === req.query.teacherEmail);
        return res.json(users);
      }
      const query: any = {};
      if (req.query.role) query.role = req.query.role;
      if (req.query.email) query.email = req.query.email;
      if (req.query.teacherEmail) query.teacherEmail = req.query.teacherEmail;
      const users = await UserProfileModel.find(query);
      res.json(users);
    } catch (err) {
      console.error("Error in /api/users:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/users/:uid", async (req, res) => {
    try {
      if (!isDbReady()) {
        const user = memUsers.get(req.params.uid);
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }
        return res.json(user);
      }
      const user = await UserProfileModel.findOne({ uid: req.params.uid });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      res.json(user);
    } catch (err) {
      console.error("Error in /api/users/:uid:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // --- AI Agent Routes ---
  setupAgentRoutes(app, ai);

  app.post("/api/users/:uid", async (req, res) => {
    try {
      if (!isDbReady()) {
        const existing = memUsers.get(req.params.uid) || { uid: req.params.uid };
        const updated = { ...existing, ...req.body, uid: req.params.uid };
        memUsers.set(req.params.uid, updated);
        return res.json(updated);
      }
      const user = await UserProfileModel.findOneAndUpdate(
        { uid: req.params.uid },
        { ...req.body },
        { new: true, upsert: true }
      );
      res.json(user);
    } catch (err) {
      console.error("Error in POST /api/users/:uid:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Prompts / Broadcasts
  app.post("/api/prompts/broadcast", async (req, res) => {
    try {
      const { text, cohort, mentorId } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Prompt text is required" });
      }
      if (!isDbReady()) {
        const newPrompt = {
          id: `prompt_${Date.now()}`,
          mentorId: mentorId || "system",
          text,
          cohort: cohort || "All Students",
          createdAt: new Date()
        };
        memPrompts.push(newPrompt);
        return res.json({ success: true, prompt: newPrompt });
      }
      const newPrompt = new PromptModel({
        id: new mongoose.Types.ObjectId().toString(),
        mentorId: mentorId || "system",
        text,
        cohort: cohort || "All Students"
      });
      await newPrompt.save();
      res.json({ success: true, prompt: newPrompt });
    } catch (err) {
      console.error("Error in POST /api/prompts/broadcast:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/prompts/latest", async (req, res) => {
    try {
      if (!isDbReady()) {
        const latestPrompt = memPrompts.length > 0 ? memPrompts[memPrompts.length - 1] : null;
        return res.json(latestPrompt);
      }
      const latestPrompt = await PromptModel.findOne().sort({ createdAt: -1 });
      res.json(latestPrompt || null);
    } catch (err) {
      console.error("Error in GET /api/prompts/latest:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Tasks
  app.get("/api/tasks", async (req, res) => {
    try {
      if (!isDbReady()) {
        let tasks = Array.from(memTasks.values());
        if (req.query.studentId) tasks = tasks.filter(t => t.studentId === req.query.studentId);
        return res.json(tasks);
      }
      const query: any = {};
      if (req.query.studentId) query.studentId = req.query.studentId;
      
      const tasks = await TaskModel.find(query).sort({ createdAt: -1 });
      
      const mappedTasks = tasks.map(t => {
        const obj = t.toObject();
        if (!obj.id) obj.id = obj._id.toString();
        return obj;
      });
      res.json(mappedTasks);
    } catch (err) {
      console.error("Error in /api/tasks:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    try {
      if (!isDbReady()) {
        const id = req.body.id || `task_${Date.now()}`;
        const task = { ...req.body, id };
        memTasks.set(id, task);
        return res.json({ id });
      }
      const newTask = new TaskModel(req.body);
      const savedTask = await newTask.save();
      const obj = savedTask.toObject();
      obj.id = obj._id.toString();
      
      await TaskModel.findByIdAndUpdate(savedTask._id, { id: obj.id });
      
      res.json({ id: obj.id });
    } catch (err) {
      console.error("Error in POST /api/tasks:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.put("/api/tasks/:id", async (req, res) => {
    try {
      if (!isDbReady()) {
        const existing = memTasks.get(req.params.id) || {};
        const updated = { ...existing, ...req.body, id: req.params.id };
        memTasks.set(req.params.id, updated);
        return res.json({ success: true });
      }
      await TaskModel.findOneAndUpdate({ id: req.params.id }, req.body);
      res.json({ success: true });
    } catch (err) {
      console.error("Error in PUT /api/tasks/:id:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    try {
      if (!isDbReady()) {
        memTasks.delete(req.params.id);
        return res.json({ success: true });
      }
      await TaskModel.findOneAndDelete({ id: req.params.id });
      res.json({ success: true });
    } catch (err) {
      console.error("Error in DELETE /api/tasks/:id:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Courses
  app.get("/api/courses", async (req, res) => {
    try {
      if (!isDbReady()) {
        const courses = Array.from(memCourses.values()).sort((a, b) => (a.order || 0) - (b.order || 0));
        return res.json(courses);
      }
      let courses = await CourseModel.find().sort({ order: 1 });
      
      if (courses.length === 0) {
        console.log("No courses found. Seeding dummy data...");
        const defaultCourse = new CourseModel({
          id: "course-demo",
          classLevel: "Class 10",
          subject: "Physics",
          title: "Introduction to Kinematics",
          description: "A foundational course on motion and forces.",
          order: 1
        });
        await defaultCourse.save();
        
        const defaultModule = new ModuleModel({
          id: "mod-demo-1",
          courseId: "course-demo",
          term: "Term 1",
          title: "Mechanics",
          learningObjectives: ["Understand velocity and acceleration", "Apply Newton's Laws"],
          order: 1
        });
        await defaultModule.save();
        
        const defaultLesson = new LessonModel({
          id: "les-demo-1",
          moduleId: "mod-demo-1",
          month: "April",
          theme: "Motion",
          topic: "Velocity vs. Speed",
          learningOutcome: "Distinguish between scalar and vector quantities of motion.",
          instructionalFlow: [
            { step: "Hook", duration: "5 mins", activity: "Show a racecar video." },
            { step: "Direct Instruction", duration: "15 mins", activity: "Explain concepts." },
            { step: "Practice", duration: "15 mins", activity: "Worksheet on velocity calculation." },
            { step: "Closure", duration: "5 mins", activity: "Exit ticket." }
          ],
          resources: ["Video link", "Worksheet PDF"],
          order: 1
        });
        await defaultLesson.save();

        courses = [defaultCourse];
      }
      
      res.json(courses);
    } catch (err) {
      console.error("Error in /api/courses:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/courses", async (req, res) => {
    try {
      if (!isDbReady()) {
        memCourses.set(req.body.id, req.body);
        return res.json(req.body);
      }
      const course = await CourseModel.findOneAndUpdate(
        { id: req.body.id },
        { ...req.body },
        { new: true, upsert: true }
      );
      res.json(course);
    } catch (err) {
      console.error("Error in POST /api/courses:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/courses/:courseId/modules", async (req, res) => {
    try {
      if (!isDbReady()) {
        const modules = Array.from(memModules.values())
          .filter(m => m.courseId === req.params.courseId)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        return res.json(modules);
      }
      const modules = await ModuleModel.find({ courseId: req.params.courseId }).sort({ order: 1 });
      res.json(modules);
    } catch (err) {
      console.error("Error in /api/courses/:courseId/modules:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/courses/:courseId/modules", async (req, res) => {
    try {
      if (!isDbReady()) {
        const mod = { ...req.body, courseId: req.params.courseId };
        memModules.set(req.body.id, mod);
        return res.json(mod);
      }
      const module = await ModuleModel.findOneAndUpdate(
        { id: req.body.id },
        { ...req.body, courseId: req.params.courseId },
        { new: true, upsert: true }
      );
      res.json(module);
    } catch (err) {
      console.error("Error in POST /api/courses/:courseId/modules:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/courses/:courseId/modules/:moduleId/lessons", async (req, res) => {
    try {
      if (!isDbReady()) {
        const lessons = Array.from(memLessons.values())
          .filter(l => l.moduleId === req.params.moduleId)
          .sort((a, b) => (a.order || 0) - (b.order || 0));
        return res.json(lessons);
      }
      const lessons = await LessonModel.find({ moduleId: req.params.moduleId }).sort({ order: 1 });
      res.json(lessons);
    } catch (err) {
      console.error("Error in /api/courses/:courseId/modules/:moduleId/lessons:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/courses/:courseId/modules/:moduleId/lessons", async (req, res) => {
    try {
      if (!isDbReady()) {
        const lesson = { ...req.body, moduleId: req.params.moduleId };
        memLessons.set(req.body.id, lesson);
        return res.json(lesson);
      }
      const lesson = await LessonModel.findOneAndUpdate(
        { id: req.body.id },
        { ...req.body, moduleId: req.params.moduleId },
        { new: true, upsert: true }
      );
      res.json(lesson);
    } catch (err) {
      console.error("Error in POST /api/courses/:courseId/modules/:moduleId/lessons:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.get("/api/courses/:courseId/modules/:moduleId/lessons/:lessonId", async (req, res) => {
    try {
      if (!isDbReady()) {
        const lesson = memLessons.get(req.params.lessonId);
        if (!lesson) return res.status(404).json({ error: "Lesson not found" });
        return res.json(lesson);
      }
      const lesson = await LessonModel.findOne({ id: req.params.lessonId });
      if (!lesson) return res.status(404).json({ error: "Lesson not found" });
      res.json(lesson);
    } catch (err) {
      console.error("Error in /api/courses/:courseId/modules/:moduleId/lessons/:lessonId:", err);
      res.status(500).json({ error: "Server error" });
    }
  });


  // Serve static files in standalone production (non-Vercel environments)
  if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
    const distPath = path.join(process.cwd(), '../frontend/dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://0.0.0.0:${PORT}`);
    });
  }

  export default app;
