const fs = require('fs');
const path = require('path');

// Load .env file manually with better debugging
const envPath = path.join(__dirname, '.env');
console.log("Looking for .env at:", envPath);
console.log("File exists:", fs.existsSync(envPath));

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  console.log("Env content length:", envContent.length);
  
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        process.env[key] = value;
        console.log("Loaded:", key);
      }
    }
  });
  console.log("MongoDB related keys:", Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DB')));
} else {
  console.log(".env file not found at:", envPath);
}

const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("./src/models/user.model");

// Configuration for PBKDF2 (same as passwordHelper.js)
const iterations = 100000;
const keyLength = 64;
const digest = "sha512";

// Helper function to hash a password (same as in passwordHelper.js)
const hashPassword = (password, salt) => {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      iterations,
      keyLength,
      digest,
      (err, derivedKey) => {
        if (err) reject(err);
        resolve(derivedKey.toString("hex"));
      }
    );
  });
};

const createAdminUser = async () => {
  try {
    // Connect to MongoDB - Get MONGODB_URI from process.env
    const mongoUri = process.env.MONGODB_URI;
    
    if (!mongoUri) {
      console.error("Error: MONGODB_URI not found in environment variables");
      console.log("Available env keys:", Object.keys(process.env));
      process.exit(1);
    }

    console.log("MongoDB URI found, connecting...");
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    // Admin user details
    const adminData = {
      name: "Admin",
      email: "robin11@gmail.com",
      password: "12345678",
      role: "admin",
      isActive: true,
      isVerified: true,
    };

    // Check if user already exists
    const existingUser = await User.findOne({ email: adminData.email });
    if (existingUser) {
      console.log("Admin user already exists with email:", adminData.email);
      console.log("Existing user role:", existingUser.role);
      
      // Update existing user to admin
      existingUser.role = "admin";
      existingUser.isActive = true;
      existingUser.isVerified = true;
      await existingUser.save();
      console.log("Updated existing user to admin role");
    } else {
      // Generate salt and hash password
      const salt = crypto.randomBytes(16).toString("hex");
      const hashedPassword = await hashPassword(adminData.password, salt);

      // Create new admin user
      const adminUser = new User({
        name: adminData.name,
        email: adminData.email,
        password: hashedPassword,
        salt: salt,
        role: adminData.role,
        isActive: adminData.isActive,
        isVerified: adminData.isVerified,
      });

      await adminUser.save();
      console.log("Admin user created successfully!");
      console.log("Email:", adminData.email);
      console.log("Password:", adminData.password);
      console.log("Role:", adminData.role);
    }

    console.log("\nAdmin user setup complete!");
    process.exit(0);
  } catch (error) {
    console.error("Error creating admin user:", error.message);
    process.exit(1);
  }
};

createAdminUser();

