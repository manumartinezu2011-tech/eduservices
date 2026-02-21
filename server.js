const express = require('express')
const path = require('path')
const cors = require('cors')
const { Pool } = require('pg')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT
// Force restart 123456789

// Configuración de CORS para desarrollo local y red
const corsOptions = {
  origin: function (origin, callback) {
    // Lista de orígenes permitidos
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:4173',
      'http://127.0.0.1:3001',
      'http://147.79.104.88',
      'http://147.79.104.88:3000',
      'http://erpedu-erpweb-kuac0y-edf950-147-79-104-88.traefik.me',
      'http://erpedu-erpweb-kuac0y-edf950-147-79-104-88.traefik.me:3000',
    ];

    // Permitir solicitudes sin origen (como apps móviles o Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('Origen bloqueado por CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Database connection
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
})

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to PostgreSQL:', err.message)
    console.log('💡 Please check your database configuration in .env file')
    console.log('📖 See backend/database/SETUP_INSTRUCTIONS.md for setup help')
  } else {
    console.log('✅ Connected to PostgreSQL database')
    release()
  }
})

// Export pool for use in other modules
module.exports.pool = pool

// Import routes (PostgreSQL-dependent routes temporarily disabled)
const productRoutes = require('./routes/products')
const billingRoutes = require('./routes/billing')
const customersRoutes = require('./routes/customers')
const inventoryRoutes = require('./routes/inventory')
const ordersRoutes = require('./routes/orders')
const suppliersRoutes = require('./routes/suppliers')
const purchaseOrdersRoutes = require('./routes/purchaseOrders')
const dashboardRoutes = require('./routes/dashboard')
const profileRoutes = require('./routes/profile')
const settingsRoutes = require('./routes/settings')
const reportsRoutes = require('./routes/reports')
const unitsRoutes = require('./routes/units')
const paymentsRoutes = require('./routes/payments')
const registerRoutes = require('./routes/register')

// Authentication routes (now using real PostgreSQL backend)
const authRoutes = require('./routes/auth')

// Use routes (PostgreSQL-dependent routes temporarily disabled)
app.use('/api/products', productRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/customers', customersRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/orders', ordersRoutes)
app.use('/api/suppliers', suppliersRoutes)
app.use('/api/purchase-orders', purchaseOrdersRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/profile', profileRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/reports', reportsRoutes)
app.use('/api/units', unitsRoutes)
app.use('/api/payments', paymentsRoutes)
app.use('/api/register', registerRoutes)

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'FreshFruit ERP API',
    database: pool ? 'Connected' : 'Disconnected'
  })
})

// Catch-all for undefined API routes (after all specific routes)
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'API endpoint not found',
    message: `The endpoint ${req.originalUrl} does not exist`
  })
})

// 404 handler
// Serve static files from the Vue app build directory
app.use(express.static(path.join(__dirname, '../dist')))

// Handle SPA routing: serve index.html for any remaining routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  })
})

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`Health check: http://localhost:${PORT}/api/health`)
});

module.exports = { app, pool }  // Temporarily disabled
//module.exports = { app }