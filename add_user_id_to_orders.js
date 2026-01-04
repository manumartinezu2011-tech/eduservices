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
        console.log('Starting migration: Add user_id to orders table...')

        await client.query('BEGIN')

        // Check if column exists
        const checkResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'orders' AND column_name = 'user_id'
    `)

        if (checkResult.rows.length === 0) {
            // Add user_id column
            await client.query(`
        ALTER TABLE orders
        ADD COLUMN user_id UUID REFERENCES users(id)
      `)
            console.log('✓ Added user_id column to orders table')
        } else {
            console.log('! user_id column already exists in orders table')
        }

        await client.query('COMMIT')

        // Verify
        const verifyResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'orders' AND column_name = 'user_id'
    `)

        console.log('\nVerification:')
        console.log(verifyResult.rows[0])

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
