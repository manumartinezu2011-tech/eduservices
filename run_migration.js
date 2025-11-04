// Run database migration to fix category color column length
const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'freshfruit_erp',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD
})

async function runMigration() {
  const client = await pool.connect()

  try {
    console.log('Starting migration: Fix category color column length...')

    await client.query('BEGIN')

    // Alter the color column to accept longer values (Tailwind CSS classes)
    await client.query(`
      ALTER TABLE categories
      ALTER COLUMN color TYPE VARCHAR(100)
    `)

    await client.query('COMMIT')

    console.log('✓ Successfully updated categories.color column to VARCHAR(100)')

    // Verify the change
    const result = await client.query(`
      SELECT column_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'categories' AND column_name = 'color'
    `)

    console.log('\nVerification:')
    console.log(result.rows[0])

  } catch (error) {
    await client.query('ROLLBACK')
    console.error('✗ Migration failed:', error.message)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

runMigration()
  .then(() => {
    console.log('\n✓ Migration completed successfully!')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n✗ Migration failed:', error)
    process.exit(1)
  })
