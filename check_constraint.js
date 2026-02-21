const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function check() {
    try {
        const query = `
            SELECT
                conname AS constraint_name,
                pg_get_constraintdef(c.oid) AS constraint_definition
            FROM
                pg_constraint c
            JOIN
                pg_namespace n ON n.oid = c.connamespace
            WHERE
                contype = 'c' AND conname = 'users_role_check';
        `;
        const result = await pool.query(query);
        console.log('--- Constraint Definition ---');
        console.log(JSON.stringify(result.rows, null, 2));

        const usersQueryResult = await pool.query('SELECT role, count(*) FROM users GROUP BY role');
        console.log('\n--- Current User Roles ---');
        console.log(JSON.stringify(usersQueryResult.rows, null, 2));

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

check();
