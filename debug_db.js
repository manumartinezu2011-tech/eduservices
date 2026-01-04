const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function debug() {
    try {
        console.log('--- Recent Orders ---');
        const orders = await pool.query('SELECT id, order_number, total FROM orders ORDER BY created_at DESC LIMIT 5');
        console.log(JSON.stringify(orders.rows, null, 2));

        console.log('\n--- Recent Payments ---');

        // Note: order_number is NOT in payments table usually, but query above selects it? 
        // Wait, the select query in verify_payments.js should select columns that exist.
        // I'll select * to be safe or specific columns.
        const paymentsReal = await pool.query('SELECT id, order_id, amount, payment_date FROM payments ORDER BY payment_date DESC LIMIT 5');
        console.log(JSON.stringify(paymentsReal.rows, null, 2));

        if (orders.rows.length > 0) {
            const orderId = orders.rows[0].id;
            console.log(`\n--- Payments for Order ${orders.rows[0].order_number} (${orderId}) ---`);
            const orderPayments = await pool.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
            console.log(JSON.stringify(orderPayments.rows, null, 2));
        }

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

debug();
