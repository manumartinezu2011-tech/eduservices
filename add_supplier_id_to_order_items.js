const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function runMigration() {
    const client = await pool.connect();
    try {
        console.log('Starting migration: Add supplier_id to order_items table...');

        await client.query('BEGIN');

        // Check if column exists
        const checkRes = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'order_items' AND column_name = 'supplier_id'
    `);

        if (checkRes.rows.length === 0) {
            // Add column
            await client.query(`
        ALTER TABLE order_items 
        ADD COLUMN supplier_id UUID
      `);
            console.log('Added supplier_id column to order_items table.');
        } else {
            console.log('Column supplier_id already exists in order_items table.');
        }

        await client.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error running migration:', error);
    } finally {
        client.release();
        pool.end();
    }
}

runMigration();
