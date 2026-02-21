const express = require('express')
const router = express.Router()
const { Pool } = require('pg')
const { body, validationResult } = require('express-validator')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h'

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

// POST /api/auth/login - User login
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

    // Find user by email
    const userQuery = `
      SELECT u.*
      FROM users u
      WHERE u.email = $1 AND u.deleted_at IS NULL
    `

    const userResult = await pool.query(userQuery, [email])

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      })
    }

    const user = userResult.rows[0]

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password_hash)

    if (!isPasswordValid) {
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

    res.json({
      success: true,
      data: {
        user: {
          ...userWithoutPassword,
          name: user.full_name, // Map full_name to name for consistency
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
    console.error('Error during login:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/auth/register - User registration (admin only)
router.post('/register', [
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['admin', 'manager', 'vendedor', 'user', 'cajero']).withMessage('Invalid role')
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

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const { name, email, password, role, avatar } = req.body

    // Check if email already exists
    const existingUser = await client.query(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email]
    )

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK')
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      })
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    // Generate username from email
    const username = email.split('@')[0] + Math.floor(Math.random() * 1000)

    // Insert new user
    const insertUserQuery = `
      INSERT INTO users (username, email, password_hash, full_name, role, avatar)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, username, email, full_name, role, avatar, created_at
    `

    const newUserResult = await client.query(insertUserQuery, [
      username,
      email,
      hashedPassword,
      name,
      role,
      avatar || null
    ])

    const newUser = newUserResult.rows[0]

    await client.query('COMMIT')

    res.status(201).json({
      success: true,
      data: {
        user: {
          ...newUser,
          name: newUser.full_name
        }
      },
      message: 'User created successfully'
    })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error during registration:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  } finally {
    client.release()
  }
})

// POST /api/auth/logout - User logout
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress
    const userAgent = req.get('User-Agent')

    // Remove session record
    await pool.query(`
      DELETE FROM user_sessions 
      WHERE user_id = $1 AND ip_address = $2 AND user_agent = $3
    `, [req.user.id, clientIP, userAgent])

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

// GET /api/auth/me - Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userQuery = `
      SELECT 
        u.id, u.full_name as name, u.email, u.role, u.avatar, u.created_at, u.last_login_at,
        up.email_notifications,
        up.push_notifications,
        up.dark_mode,
        up.language,
        up.timezone
      FROM users u
      LEFT JOIN user_preferences up ON u.id = up.user_id
      WHERE u.id = $1 AND u.deleted_at IS NULL
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
        user: {
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
      }
    })
  } catch (error) {
    console.error('Error fetching user info:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// POST /api/auth/change-password - Change user password
router.post('/change-password', [
  body('current_password').notEmpty().withMessage('Current password is required'),
  body('new_password').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  body('confirm_password').custom((value, { req }) => {
    if (value !== req.body.new_password) {
      throw new Error('Password confirmation does not match')
    }
    return true
  })
], authenticateToken, async (req, res) => {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      errors: errors.array()
    })
  }

  try {
    const { current_password, new_password } = req.body

    // Get current user with password
    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.user.id]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      })
    }

    const user = userResult.rows[0]

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(current_password, user.password)

    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        error: 'Current password is incorrect'
      })
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(new_password, 12)

    // Update password
    await pool.query(
      'UPDATE users SET password = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [req.user.id, hashedNewPassword]
    )

    res.json({
      success: true,
      message: 'Password changed successfully'
    })
  } catch (error) {
    console.error('Error changing password:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/auth/sessions - Get active user sessions
router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const sessionsQuery = `
      SELECT 
        id,
        ip_address,
        user_agent,
        last_activity,
        created_at
      FROM user_sessions
      WHERE user_id = $1
      ORDER BY last_activity DESC
      LIMIT 10
    `

    const result = await pool.query(sessionsQuery, [req.user.id])

    res.json({
      success: true,
      data: { sessions: result.rows }
    })
  } catch (error) {
    console.error('Error fetching sessions:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// DELETE /api/auth/sessions/:id - Terminate specific session
router.delete('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query(
      'DELETE FROM user_sessions WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, req.user.id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      })
    }

    res.json({
      success: true,
      message: 'Session terminated successfully'
    })
  } catch (error) {
    console.error('Error terminating session:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// Cleanup old sessions (utility endpoint for admin)
router.post('/cleanup-sessions', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required'
    })
  }

  try {
    // Remove sessions older than 30 days
    const result = await pool.query(`
      DELETE FROM user_sessions 
      WHERE last_activity < CURRENT_TIMESTAMP - INTERVAL '30 days'
      RETURNING COUNT(*)
    `)

    res.json({
      success: true,
      message: `Cleaned up old sessions`,
      data: { sessions_removed: result.rowCount }
    })
  } catch (error) {
    console.error('Error cleaning up sessions:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// Temporary endpoint to create demo users (REMOVE IN PRODUCTION)
router.post('/create-demo-users', async (req, res) => {
  try {
    const demoPassword = 'password123'
    const hashedPassword = await bcrypt.hash(demoPassword, 12)

    // Create demo users
    const demoUsers = [
      { username: 'admin', email: 'admin@freshfruit.com', full_name: 'System Administrator', role: 'admin' },
      { username: 'manager', email: 'manager@freshfruit.com', full_name: 'Store Manager', role: 'manager' },
      { username: 'vendedor', email: 'vendedor@freshfruit.com', full_name: 'Vendedor Demo', role: 'vendedor' },
      { username: 'user1', email: 'user1@freshfruit.com', full_name: 'Juan Carlos Pérez', role: 'user' },
      { username: 'user2', email: 'user2@freshfruit.com', full_name: 'María González', role: 'user' }
    ]

    const createdUsers = []

    for (const user of demoUsers) {
      try {
        // Check if user already exists
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [user.email])

        if (existingUser.rows.length === 0) {
          // Insert new user
          const insertQuery = `
            INSERT INTO users (username, email, password_hash, full_name, role)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, username, email, full_name, role
          `
          const result = await pool.query(insertQuery, [
            user.username,
            user.email,
            hashedPassword,
            user.full_name,
            user.role
          ])
          createdUsers.push(result.rows[0])
        } else {
          // Update existing user password
          await pool.query(
            'UPDATE users SET password_hash = $1 WHERE email = $2',
            [hashedPassword, user.email]
          )
          createdUsers.push({ ...user, status: 'updated' })
        }
      } catch (userError) {
        console.error(`Error creating user ${user.email}:`, userError)
        createdUsers.push({ ...user, error: userError.message })
      }
    }

    res.json({
      success: true,
      message: `Demo users processed successfully`,
      demo_password: demoPassword,
      users: createdUsers
    })
  } catch (error) {
    console.error('Error creating demo users:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// Temporary endpoint to create sample data for testing (REMOVE IN PRODUCTION)
router.post('/create-sample-data', async (req, res) => {
  try {
    // Clear existing sample data first
    await pool.query('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders)')
    await pool.query('DELETE FROM orders')
    await pool.query('DELETE FROM products')
    await pool.query('DELETE FROM categories')
    await pool.query('DELETE FROM customers WHERE email LIKE \'%@%\' AND name != \'Admin User\'')

    // Create sample customers
    const customersQuery = `
      INSERT INTO customers (name, email, phone, type, balance, created_at) VALUES
      ('Mercado Central', 'mercado@central.com', '+1-555-1001', 'business', 0.00, CURRENT_DATE - INTERVAL '30 days'),
      ('Supermercados Unidos', 'contacto@superunidos.com', '+1-555-1002', 'business', 500.00, CURRENT_DATE - INTERVAL '25 days'),
      ('Frutas del Valle', 'info@frutasvalle.com', '+1-555-1003', 'business', -200.00, CURRENT_DATE - INTERVAL '20 days'),
      ('Juan Pérez', 'juan.perez@email.com', '+1-555-1004', 'individual', 0.00, CURRENT_DATE - INTERVAL '15 days'),
      ('María González', 'maria.gonzalez@email.com', '+1-555-1005', 'individual', 100.00, CURRENT_DATE - INTERVAL '10 days')
    `

    await pool.query(customersQuery)

    // Create sample categories
    const categoriesQuery = `
      INSERT INTO categories (name, slug, color) VALUES
      ('Frutas Tropicales', 'tropicales', '#FFA726'),
      ('Cítricos', 'citricos', '#FF7043'), 
      ('Berries', 'berries', '#EF5350')
    `

    await pool.query(categoriesQuery)

    // Get category IDs
    const categoriesResult = await pool.query('SELECT id, slug FROM categories')
    const categoryMap = categoriesResult.rows.reduce((map, cat) => {
      map[cat.slug] = cat.id
      return map
    }, {})

    // Create sample products
    const productsQuery = `
      INSERT INTO products (name, sku, price, cost, stock, min_stock, unit, category_id) VALUES
      ('Plátano Premium', 'TROP-001', 2.50, 1.50, 100, 20, 'kg', $1),
      ('Mango Kent', 'TROP-002', 4.00, 2.80, 75, 15, 'kg', $1),
      ('Naranja Valencia', 'CIT-001', 3.00, 2.00, 80, 25, 'kg', $2),
      ('Limón Persa', 'CIT-002', 3.50, 2.20, 60, 20, 'kg', $2),
      ('Fresa Orgánica', 'BER-001', 8.00, 5.50, 30, 10, 'kg', $3),
      ('Arándano Premium', 'BER-002', 12.00, 8.00, 20, 5, 'kg', $3)
    `

    await pool.query(productsQuery, [
      categoryMap['tropicales'],
      categoryMap['tropicales'],
      categoryMap['citricos'],
      categoryMap['citricos'],
      categoryMap['berries'],
      categoryMap['berries']
    ])

    // Get customer and product IDs for orders
    const customersResult = await pool.query('SELECT id, name FROM customers LIMIT 5')
    const productsResult = await pool.query('SELECT id, name, price FROM products LIMIT 6')

    const customers = customersResult.rows
    const products = productsResult.rows

    // Create sample orders
    for (let i = 1; i <= 10; i++) {
      const customer = customers[i % customers.length]
      const orderDate = new Date()
      orderDate.setDate(orderDate.getDate() - (i * 2))

      const orderNumber = `ORD-${String(i).padStart(3, '0')}`

      // Insert order
      const orderQuery = `
        INSERT INTO orders (order_number, customer_id, order_date, status, payment_method, subtotal, tax_amount, total)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `

      const subtotal = 50 + (i * 10)
      const taxAmount = subtotal * 0.1
      const total = subtotal + taxAmount

      const orderResult = await pool.query(orderQuery, [
        orderNumber,
        customer.id,
        orderDate,
        i <= 7 ? 'completed' : i <= 9 ? 'processing' : 'pending',
        ['cash', 'card', 'transfer'][i % 3],
        subtotal,
        taxAmount,
        total
      ])

      const orderId = orderResult.rows[0].id

      // Insert order items
      const product1 = products[i % products.length]
      const product2 = products[(i + 1) % products.length]

      const orderItemsQuery = `
        INSERT INTO order_items (order_id, product_id, product_name, sku, quantity, unit_price, total)
        VALUES 
        ($1, $2, $3, $4, $5, $6, $7),
        ($8, $9, $10, $11, $12, $13, $14)
      `

      await pool.query(orderItemsQuery, [
        orderId, product1.id, product1.name, 'SKU-' + product1.id, 5, product1.price, 5 * product1.price,
        orderId, product2.id, product2.name, 'SKU-' + product2.id, 3, product2.price, 3 * product2.price
      ])
    }

    res.json({
      success: true,
      message: 'Sample data created successfully',
      data: {
        customers: customers.length,
        products: products.length,
        orders: 10,
        order_items: 20
      }
    })
  } catch (error) {
    console.error('Error creating sample data:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// GET /api/auth/users - Get all users (admin and manager only)
router.get('/users', authenticateToken, async (req, res) => {
  // Check if current user has permission to view users
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: 'Insufficient permissions to view users'
    })
  }

  try {
    const usersQuery = `
      SELECT 
        u.id, 
        u.username, 
        u.email, 
        u.full_name, 
        u.role, 
        u.created_at, 
        u.updated_at
      FROM users u
      WHERE u.deleted_at IS NULL
      ORDER BY u.created_at DESC
    `

    const result = await pool.query(usersQuery)

    res.json({
      success: true,
      data: { users: result.rows }
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

// PUT /api/auth/users/:id - Update user (admin only)
router.put('/users/:id', [
  body('name').optional().notEmpty().withMessage('Name cannot be empty'),
  body('email').optional().isEmail().withMessage('Valid email is required'),
  body('role').optional().isIn(['admin', 'manager', 'vendedor', 'user', 'cajero']).withMessage('Invalid role')
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
  const updates = {}
  const allowedFields = ['name', 'email', 'role', 'password']

  // Build update object
  allowedFields.forEach(field => {
    if (req.body[field] !== undefined) {
      if (field === 'name') {
        updates.full_name = req.body[field]
      } else {
        updates[field] = req.body[field]
      }
    }
  })

  // Handle password hashing if present
  if (updates.password) {
    // Only update if password is not empty
    if (updates.password.trim() === '') {
      delete updates.password
    } else {
      updates.password_hash = await bcrypt.hash(updates.password, 12)
      delete updates.password // Remove plain text password
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No valid fields to update'
    })
  }

  try {
    // Check if user exists
    const userExists = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )

    if (userExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      })
    }

    // If email is being updated, check for duplicates
    if (updates.email) {
      const emailExists = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2 AND deleted_at IS NULL',
        [updates.email, id]
      )

      if (emailExists.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Email already exists'
        })
      }
    }

    // Build dynamic update query
    const updateFields = Object.keys(updates).map((key, index) => `${key} = $${index + 2}`).join(', ')
    const updateValues = [id, ...Object.values(updates)]

    const updateQuery = `
      UPDATE users 
      SET ${updateFields}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, username, email, full_name, role, created_at, updated_at
    `

    const result = await pool.query(updateQuery, updateValues)
    const updatedUser = result.rows[0]

    res.json({
      success: true,
      data: { user: updatedUser },
      message: 'User updated successfully'
    })
  } catch (error) {
    console.error('Error updating user:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

// DELETE /api/auth/users/:id - Delete user (admin only)
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
  if (req.user.id === id) {
    return res.status(400).json({
      success: false,
      error: 'You cannot delete your own account'
    })
  }

  try {
    // Check if user exists
    const userExists = await pool.query(
      'SELECT id, full_name FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )

    if (userExists.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      })
    }

    // Soft delete the user (add deleted_at timestamp)
    const deleteQuery = `
      UPDATE users 
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `

    await pool.query(deleteQuery, [id])

    res.json({
      success: true,
      message: 'User deleted successfully'
    })
  } catch (error) {
    console.error('Error deleting user:', error)
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    })
  }
})

module.exports = router
module.exports.authenticateToken = authenticateToken