const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

async function runMigration() {
    const client = await pool.connect();
    try {
        console.log('Creating register_closures table...');

        await client.query(`
      CREATE TABLE IF NOT EXISTS register_closures (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        closing_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        total_sales DECIMAL(10, 2) NOT NULL DEFAULT 0,
        details JSONB DEFAULT '[]'::jsonb,
        user_id UUID REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

        console.log('✅ register_closures table created successfully');
    } catch (err) {
        console.error('❌ Error creating table:', err);
    } finally {
        client.release();
        pool.end();
    }
}

runMigration();
