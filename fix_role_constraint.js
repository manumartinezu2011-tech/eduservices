
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function fixConstraint() {
    const client = await pool.connect();
    try {
        console.log('Fixing users_role_check constraint...');

        await client.query('BEGIN');

        // 1. Drop existing constraint
        console.log('Dropping old constraint...');
        await client.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');

        // 2. Add new constraint with 'cajero'
        console.log('Adding new constraint...');
        await client.query(`
      ALTER TABLE users 
      ADD CONSTRAINT users_role_check 
      CHECK (role IN ('admin', 'manager', 'vendedor', 'user', 'cajero'))
    `);

        await client.query('COMMIT');
        console.log('Successfully updated users table constraints.');

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error executing migration:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

fixConstraint();
