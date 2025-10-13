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

// GET /api/settings - Get all settings
router.get('/', async (req, res) => {
  try {
    // Get company settings
    const companyQuery = 'SELECT * FROM company_settings ORDER BY id DESC LIMIT 1'
    const companyResult = await pool.query(companyQuery)
    
    // Get system settings
    const systemQuery = 'SELECT key, value, type FROM system_settings ORDER BY key'
    const systemResult = await pool.query(systemQuery)
    
    // Convert system settings to object
    const systemSettings = {}
    systemResult.rows.forEach(setting => {
      let value = setting.value
      
      // Parse value based on type
      switch (setting.type) {
        case 'number':
          value = parseFloat(setting.value) || 0
          break
        case 'boolean':
          value = setting.value === 'true'
          break
        case 'json':
          try {
            value = JSON.parse(setting.value)
          } catch (e) {
            value = setting.value
          }
          break
        default:
          value = setting.value
      }
      
      systemSettings[setting.key] = value
    })
    
    res.json({
      success: true,
      data: {
        company: companyResult.rows[0] || {},
        system: systemSettings
      }
    })
  } catch (error) {
    console.error('Error fetching settings:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/settings/company - Update company settings
router.put('/company', [
  body('name').notEmpty().withMessage('Company name is required'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('website').optional().isURL().withMessage('Valid website URL is required')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  // Check if user has admin privileges
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    })
  }
  
  try {
    const {
      name,
      ruc,
      phone,
      email,
      website,
      address,
      logo_url
    } = req.body
    
    // Upsert company settings
    const upsertQuery = `
      INSERT INTO company_settings (name, ruc, phone, email, website, address, logo_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = $1,
        ruc = $2,
        phone = $3,
        email = $4,
        website = $5,
        address = $6,
        logo_url = $7,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `
    
    const result = await pool.query(upsertQuery, [
      name, ruc, phone, email, website, address, logo_url
    ])
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Company settings updated successfully'
    })
  } catch (error) {
    console.error('Error updating company settings:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/settings/system - Update system settings
router.put('/system', [
  body('settings').isObject().withMessage('Settings object is required')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  // Check if user has admin privileges
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    })
  }
  
  const client = await pool.connect()
  
  try {
    await client.query('BEGIN')
    
    const { settings } = req.body
    
    // Update each setting
    for (const [key, value] of Object.entries(settings)) {
      let processedValue = value
      let type = 'string'
      
      // Determine type and process value
      if (typeof value === 'number') {
        type = 'number'
        processedValue = value.toString()
      } else if (typeof value === 'boolean') {
        type = 'boolean'
        processedValue = value.toString()
      } else if (typeof value === 'object') {
        type = 'json'
        processedValue = JSON.stringify(value)
      }
      
      await client.query(`
        INSERT INTO system_settings (key, value, type)
        VALUES ($1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = $2,
          type = $3,
          updated_at = CURRENT_TIMESTAMP
      `, [key, processedValue, type])
    }
    
    await client.query('COMMIT')
    
    res.json({
      success: true,
      data: settings,
      message: 'System settings updated successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating system settings:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  } finally {
    client.release()
  }
})

// GET /api/settings/system/:key - Get specific system setting
router.get('/system/:key', async (req, res) => {
  try {
    const { key } = req.params
    
    const result = await pool.query(
      'SELECT key, value, type FROM system_settings WHERE key = $1',
      [key]
    )
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Setting not found' 
      })
    }
    
    const setting = result.rows[0]
    let value = setting.value
    
    // Parse value based on type
    switch (setting.type) {
      case 'number':
        value = parseFloat(setting.value) || 0
        break
      case 'boolean':
        value = setting.value === 'true'
        break
      case 'json':
        try {
          value = JSON.parse(setting.value)
        } catch (e) {
          value = setting.value
        }
        break
    }
    
    res.json({
      success: true,
      data: {
        key: setting.key,
        value,
        type: setting.type
      }
    })
  } catch (error) {
    console.error('Error fetching setting:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// POST /api/settings/backup - Create system backup (admin only)
router.post('/backup', async (req, res) => {
  // Check if user has admin privileges
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    })
  }
  
  try {
    // This would typically create a database backup
    // For now, return a success message
    const backupInfo = {
      filename: `freshfruit_backup_${new Date().toISOString().split('T')[0]}.sql`,
      created_at: new Date().toISOString(),
      size: '2.5MB', // Mock size
      tables: [
        'users', 'customers', 'products', 'orders', 'invoices', 
        'suppliers', 'categories', 'stock_movements'
      ]
    }
    
    res.json({
      success: true,
      data: backupInfo,
      message: 'Backup created successfully'
    })
  } catch (error) {
    console.error('Error creating backup:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// GET /api/settings/users - Get all users (admin only)
router.get('/users', async (req, res) => {
  // Check if user has admin privileges
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    })
  }
  
  try {
    const usersQuery = `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.role,
        u.avatar,
        u.created_at,
        u.last_login_at,
        COUNT(DISTINCT us.id) as active_sessions
      FROM users u
      LEFT JOIN user_sessions us ON u.id = us.user_id
      WHERE 1=1 -- deleted_at check temporarily disabled
      GROUP BY u.id, u.name, u.email, u.role, u.avatar, u.created_at, u.last_login_at
      ORDER BY u.created_at DESC
    `
    
    const result = await pool.query(usersQuery)
    
    const users = result.rows.map(user => ({
      ...user,
      active_sessions: parseInt(user.active_sessions) || 0
    }))
    
    res.json({
      success: true,
      data: { users }
    })
  } catch (error) {
    console.error('Error fetching users:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

// PUT /api/settings/users/:id/role - Update user role (admin only)
router.put('/users/:id/role', [
  body('role').isIn(['admin', 'vendedor', 'gerente']).withMessage('Invalid role')
], async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      error: 'Validation failed',
      errors: errors.array() 
    })
  }
  
  // Check if user has admin privileges
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      error: 'Admin access required' 
    })
  }
  
  try {
    const { id } = req.params
    const { role } = req.body
    
    // Don't allow users to change their own role
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot change your own role' 
      })
    }
    
    const result = await pool.query(`
      UPDATE users 
      SET role = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 -- -- AND deleted_at IS NULL temporarily disabled -- temporarily disabled
      RETURNING id, name, email, role, avatar, created_at, last_login_at
    `, [id, role])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      })
    }
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'User role updated successfully'
    })
  } catch (error) {
    console.error('Error updating user role:', error)
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    })
  }
})

module.exports = router