const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

async function addSupplierColumn() {
  try {
    console.log('Adding supplier column to products table...')
    
    // Add supplier column directly (simpler approach)
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier VARCHAR(255)`)
    console.log('✓ Added supplier column to products table')
    
    // Update existing products with a default supplier
    const result = await pool.query(`UPDATE products SET supplier = 'Proveedor General' WHERE supplier IS NULL`)
    console.log(`✓ Updated ${result.rowCount} existing products with default supplier`)
    
    // Create index for better performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier) WHERE supplier IS NOT NULL`)
    console.log('✓ Created index on supplier column')
    
    console.log('\nMigration completed successfully!')
    console.log('Products table now has supplier column and the API should work correctly.')
    
  } catch (error) {
    if (error.message.includes('column "supplier" of relation "products" already exists')) {
      console.log('✓ Supplier column already exists in products table')
    } else {
      console.error('Migration failed:', error.message)
      process.exit(1)
    }
  } finally {
    await pool.end()
  }
}

addSupplierColumn()