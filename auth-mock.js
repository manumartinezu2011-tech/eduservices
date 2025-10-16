const express = require('express')
const router = express.Router()
const { body, validationResult } = require('express-validator')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

// Mock users database (in memory - for testing only)
const mockUsers = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@freshfruit.com',
    password_hash: '$2b$12$2NJx/fRKd4nNGupEGGZZg.5U1/LM7niEmbey4cPD10XpjT6LtFL1y', // password123
    full_name: 'System Administrator',
    role: 'admin',
    created_at: new Date(),
    deleted_at: null
  },
  {
    id: 2,
    username: 'manager',
    email: 'manager@freshfruit.com',
    password_hash: '$2b$12$2NJx/fRKd4nNGupEGGZZg.5U1/LM7niEmbey4cPD10XpjT6LtFL1y', // password123
    full_name: 'Store Manager',
    role: 'manager',
    created_at: new Date(),
    deleted_at: null
  },
  {
    id: 3,
    username: 'user1',
    email: 'user1@freshfruit.com',
    password_hash: '$2b$12$2NJx/fRKd4nNGupEGGZZg.5U1/LM7niEmbey4cPD10XpjT6LtFL1y', // password123
    full_name: 'Juan Carlos Pérez',
    role: 'user',
    created_at: new Date(),
    deleted_at: null
  }
]

// Middleware to authenticate JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token is required' 
    })
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        error: 'Invalid or expired token' 
      })
    }
    req.user = user
    next()
  })
}

// POST /api/auth/login - User login (MOCK)
router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  try {
    const { email, password, remember_me = false } = req.body
    
    console.log('Mock login attempt:', { email, password })
    
    // Find user by email in mock database
    const user = mockUsers.find(u => u.email === email && u.deleted_at === null)
    
    if (!user) {
      console.log('User not found:', email)
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      })
    }
    
    // Verify password (for demo purposes, all passwords are "password123")
    const isPasswordValid = await bcrypt.compare(password, user.password_hash)
    
    if (!isPasswordValid) {
      console.log('Invalid password for user:', email)
      return res.status(401).json({ 
        success: false, 
        error: 'Invalid email or password' 
      })
    }
    
    // Generate JWT token
    const tokenPayload = {
      id: user.id,
      email: user.email,
      name: user.full_name,
      role: user.role
    }
    
    const expiresIn = remember_me ? '30d' : JWT_EXPIRES_IN
    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn })
    
    // Remove password from response
    const { password_hash: _, ...userWithoutPassword } = user
    
    console.log('Login successful for:', email)
    
    res.json({
      success: true,
      data: {
        user: {
          ...userWithoutPassword,
          name: user.full_name,
          preferences: {
            email_notifications: true,
            push_notifications: true,
            dark_mode: false,
            language: 'es',
            timezone: 'America/Lima'
          }
        },
        token,
        expires_in: expiresIn
      },
      message: 'Login successful'
    })
  } catch (error) {
    console.error('Error during mock login:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/auth/me - Get current user info (MOCK)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = mockUsers.find(u => u.id === req.user.id && u.deleted_at === null)
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      })
    }
    
    const { password_hash: _, ...userWithoutPassword } = user
    
    res.json({
      success: true,
      data: {
        user: {
          ...userWithoutPassword,
          name: user.full_name,
          preferences: {
            email_notifications: true,
            push_notifications: true,
            dark_mode: false,
            language: 'es',
            timezone: 'America/Lima'
          }
        }
      }
    })
  } catch (error) {
    console.error('Error fetching mock user info:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// POST /api/auth/logout - User logout (MOCK)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Logout successful'
    })
  } catch (error) {
    console.error('Error during logout:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/auth/demo-users - Show available demo users
router.get('/demo-users', (req, res) => {
  const usersInfo = mockUsers.map(user => ({
    email: user.email,
    role: user.role,
    name: user.full_name,
    password: 'password123' // Demo password
  }))
  
  res.json({
    success: true,
    message: 'Available demo users (password for all: password123)',
    users: usersInfo
  })
})

// GET /api/auth/users - Get all users (admin and manager only) - MOCK
router.get('/users', authenticateToken, async (req, res) => {
  // Check if current user has permission to view users
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ 
      success: false, 
      error: 'Insufficient permissions to view users' 
    })
  }
  
  try {
    const users = mockUsers
      .filter(u => u.deleted_at === null)
      .map(({ password_hash, ...user }) => user)
    
    res.json({
      success: true,
      data: { users }
    })
  } catch (error) {
    console.error('Error fetching mock users:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// POST /api/auth/register - User registration (admin only) - MOCK
router.post('/register', [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['admin', 'manager', 'vendedor', 'user']).withMessage('Invalid role')
], authenticateToken, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  // Check if current user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Only administrators can create new users' 
    })
  }
  
  try {
    const { name, email, password, role } = req.body
    
    // Check if email already exists
    const existingUser = mockUsers.find(u => u.email === email && u.deleted_at === null)
    
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        error: 'User with this email already exists' 
      })
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)
    
    // Create user
    const newUser = {
      id: mockUsers.length + 1,
      username: email.split('@')[0],
      email,
      password_hash: hashedPassword,
      full_name: name,
      role,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null
    }
    
    mockUsers.push(newUser)
    
    // Remove password from response
    const { password_hash, ...userWithoutPassword } = newUser
    
    res.status(201).json({
      success: true,
      data: { user: userWithoutPassword },
      message: 'User created successfully'
    })
  } catch (error) {
    console.error('Error during mock registration:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/auth/users/:id - Update user (admin only) - MOCK
router.put('/users/:id', [
  body('name').optional().notEmpty().withMessage('Name cannot be empty'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('role').optional().isIn(['admin', 'manager', 'vendedor', 'user']).withMessage('Invalid role')
], authenticateToken, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  // Check if current user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Only administrators can update users' 
    })
  }
  
  const { id } = req.params
  
  try {
    // Find user
    const userIndex = mockUsers.findIndex(u => u.id == id && u.deleted_at === null)
    
    if (userIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      })
    }
    
    // Check for email conflicts
    if (req.body.email) {
      const emailExists = mockUsers.find(u => u.email === req.body.email && u.id != id && u.deleted_at === null)
      if (emailExists) {
        return res.status(400).json({ 
          success: false, 
          error: 'Email already exists' 
        })
      }
    }
    
    // Update user
    const user = mockUsers[userIndex]
    if (req.body.name) user.full_name = req.body.name
    if (req.body.email) user.email = req.body.email
    if (req.body.role) user.role = req.body.role
    user.updated_at = new Date()
    
    // Remove password from response
    const { password_hash, ...userWithoutPassword } = user
    
    res.json({
      success: true,
      data: { user: userWithoutPassword },
      message: 'User updated successfully'
    })
  } catch (error) {
    console.error('Error updating mock user:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// DELETE /api/auth/users/:id - Delete user (admin only) - MOCK
router.delete('/users/:id', authenticateToken, async (req, res) => {
  // Check if current user is admin
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Only administrators can delete users' 
    })
  }
  
  const { id } = req.params
  
  // Prevent self-deletion
  if (req.user.id == id) {
    return res.status(400).json({ 
      success: false, 
      error: 'You cannot delete your own account' 
    })
  }
  
  try {
    // Find user
    const userIndex = mockUsers.findIndex(u => u.id == id && u.deleted_at === null)
    
    if (userIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      })
    }
    
    // Soft delete the user
    mockUsers[userIndex].deleted_at = new Date()
    mockUsers[userIndex].updated_at = new Date()
    
    res.json({
      success: true,
      message: 'User deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting mock user:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

module.exports = router
module.exports.authenticateToken = authenticateToken