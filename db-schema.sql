CREATE DATABASE IF NOT EXISTS chris_website;
USE chris_website;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(100) UNIQUE,
  name VARCHAR(255) NOT NULL,
  surname VARCHAR(255) NOT NULL,
  firstName VARCHAR(255) NOT NULL,
  middleName VARCHAR(255),
  suffix VARCHAR(50),
  email VARCHAR(255) NOT NULL UNIQUE,
  birthday DATE,
  password VARCHAR(255),
  gender VARCHAR(50),
  role VARCHAR(50) NOT NULL DEFAULT 'employee',
  google BOOLEAN NOT NULL DEFAULT FALSE,
  mfaSecret VARCHAR(64),
  mfaMethod VARCHAR(20) NOT NULL DEFAULT 'authenticator',
  mfaCodeHash VARCHAR(255),
  mfaCodeExpiresAt DATETIME,
  mfaEnabled BOOLEAN NOT NULL DEFAULT FALSE,
  failedLoginAttempts INT NOT NULL DEFAULT 0,
  lockoutUntil DATETIME
);

CREATE TABLE IF NOT EXISTS user_profiles (
  email VARCHAR(255) PRIMARY KEY,
  department VARCHAR(255),
  position VARCHAR(255),
  phone VARCHAR(50),
  profileImage LONGTEXT,
  pdsData LONGTEXT,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGINT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  image LONGTEXT,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  date VARCHAR(20) NOT NULL,
  createdByEmail VARCHAR(255),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leaves (
  id BIGINT PRIMARY KEY,
  employeeEmail VARCHAR(255) NOT NULL,
  type VARCHAR(100) NOT NULL,
  startDate DATE NOT NULL,
  endDate DATE NOT NULL,
  days INT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Pending',
  medicalCertificate LONGTEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leaves_employee_email (employeeEmail)
);

CREATE TABLE IF NOT EXISTS attendance (
  id BIGINT PRIMARY KEY,
  employeeEmail VARCHAR(255) NOT NULL,
  date DATE NOT NULL,
  status VARCHAR(50) NOT NULL,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_attendance_employee_email (employeeEmail)
);

CREATE TABLE IF NOT EXISTS trainings (
  id BIGINT PRIMARY KEY,
  employeeEmail VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL,
  startDate DATE,
  endDate DATE,
  hours VARCHAR(50),
  type VARCHAR(100),
  sponsor VARCHAR(255),
  status VARCHAR(50),
  certificate LONGTEXT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trainings_employee_email (employeeEmail)
);

CREATE TABLE IF NOT EXISTS evaluations (
  employeeEmail VARCHAR(255) PRIMARY KEY,
  status VARCHAR(100) NOT NULL,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leave_comments (
  id BIGINT PRIMARY KEY,
  leaveId BIGINT NOT NULL,
  employeeEmail VARCHAR(255) NOT NULL,
  text TEXT NOT NULL,
  date VARCHAR(100) NOT NULL,
  createdByEmail VARCHAR(255),
  createdByRole VARCHAR(50),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leave_comments_employee_leave (employeeEmail, leaveId)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT PRIMARY KEY,
  adminEmail VARCHAR(255) NOT NULL,
  action VARCHAR(255) NOT NULL,
  target VARCHAR(255),
  details TEXT,
  timestamp DATETIME NOT NULL,
  INDEX idx_audit_logs_timestamp (timestamp)
);
