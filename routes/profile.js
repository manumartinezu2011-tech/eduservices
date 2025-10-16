const express = require('express')
const router = express.Router()
const { Pool } = require('pg')
const { body, validationResult } = require('express-validator')
const { authenticateToken } = require('./auth')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

// All routes require authentication
router.use(authenticateToken)

// GET /api/profile - Get user profile
router.get('/', async (req, res) => {
  try {
    const userQuery = `
      SELECT 
        u.id, u.name, u.email, u.role, u.avatar, u.created_at, u.last_login_at,
        up.email_notifications,
        up.push_notifications,
        up.dark_mode,
        up.language,
        up.timezone
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      WHERE u.id = $1 -- AND u.deleted_at IS NULL -- temporarily disabled
    `
    
    const result = await pool.query(userQuery, [req.user.id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      })
    }
    
    const user = result.rows[0]
    
    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        created_at: user.created_at,
        last_login_at: user.last_login_at,
        preferences: {
          email_notifications: user.email_notifications !== false,
          push_notifications: user.push_notifications !== false,
          dark_mode: user.dark_mode === true,
          language: user.language || 'es',
          timezone: user.timezone || 'America/Lima'
        }
      }
    })
  } catch (error) {
    console.error('Error fetching profile:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/profile - Update user profile
router.put('/', [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('avatar').optional().isURL()
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
    const { name, email, avatar } = req.body
    
    // Check if email is already used by another user
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2 -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled',
      [email, req.user.id]
    )
    
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Email is already in use' 
      })
    }
    
    const updateQuery = `
      UPDATE users 
      SET name = $2, email = $3, avatar = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, email, role, avatar, created_at, last_login_at
    `
    
    const result = await pool.query(updateQuery, [req.user.id, name, email, avatar])
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Profile updated successfully'
    })
  } catch (error) {
    console.error('Error updating profile:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/profile/preferences - Update user preferences
router.put('/preferences', [
  body('email_notifications').optional().isBoolean(),
  body('push_notifications').optional().isBoolean(),
  body('dark_mode').optional().isBoolean(),
  body('language').optional().isIn(['es', 'en']),
  body('timezone').optional().isString()
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
    const {
      email_notifications,
      push_notifications,
      dark_mode,
      language,
      timezone
    } = req.body
    
    // Upsert preferences
    const upsertQuery = `
      INSERT INTO user_preferences (
        user_id, email_notifications, push_notifications, dark_mode, language, timezone
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO UPDATE SET
        email_notifications = COALESCE($2, user_preferences.email_notifications),
        push_notifications = COALESCE($3, user_preferences.push_notifications),
        dark_mode = COALESCE($4, user_preferences.dark_mode),
        language = COALESCE($5, user_preferences.language),
        timezone = COALESCE($6, user_preferences.timezone),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `
    
    const result = await pool.query(upsertQuery, [
      req.user.id, email_notifications, push_notifications, dark_mode, language, timezone
    ])
    
    res.json({
      success: true,
      data: {
        email_notifications: result.rows[0].email_notifications,
        push_notifications: result.rows[0].push_notifications,
        dark_mode: result.rows[0].dark_mode,
        language: result.rows[0].language || 'es',
        timezone: result.rows[0].timezone || 'America/Lima'
      },
      message: 'Preferences updated successfully'
    })
  } catch (error) {
    console.error('Error updating preferences:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/profile/activity - Get user activity log
router.get('/activity', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query
    
    const activityQuery = `
      SELECT 
        id,
        action,
        table_name,
        record_id,
        created_at
      FROM activity_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `
    
    const result = await pool.query(activityQuery, [
      req.user.id, 
      limit, 
      (page - 1) * limit
    ])
    
    // Get total count
    const countResult = await pool.query(
      'SELECT COUNT(*) as total FROM activity_logs WHERE user_id = $1',
      [req.user.id]
    )
    
    const total = parseInt(countResult.rows[0].total)
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching activity:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

module.exports = router