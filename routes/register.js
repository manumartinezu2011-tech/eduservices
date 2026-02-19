const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// GET /api/register/summary - Get summary for the current day/shift
router.get('/summary', async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date || new Date().toISOString().split('T')[0];

        // 1. Get Sales Items (Existing logic)
        const salesQuery = `
      SELECT 
        s.id as supplier_id,
        s.name as supplier_name,
        oi.product_name,
        oi.quantity,
        oi.unit_price,
        oi.total,
        o.payment_method as sale_type
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN suppliers s ON oi.supplier_id = s.id
      WHERE DATE(o.created_at) = $1
      AND o.status != 'cancelled'
      ORDER BY s.name, oi.product_name
    `;
        const salesResult = await pool.query(salesQuery, [targetDate]);

        // Group Sales by Supplier
        const groupedSales = salesResult.rows.reduce((acc, item) => {
            const supplierName = item.supplier_name || 'Sin Proveedor';
            if (!acc[supplierName]) {
                acc[supplierName] = {
                    supplier_name: supplierName,
                    items: [],
                    supplier_total: 0
                };
            }
            acc[supplierName].items.push({
                product_name: item.product_name,
                quantity: parseFloat(item.quantity),
                unit_price: parseFloat(item.unit_price),
                sale_type: item.sale_type,
                total: parseFloat(item.total)
            });
            acc[supplierName].supplier_total += parseFloat(item.total);
            return acc;
        }, {});
        const salesDetails = Object.values(groupedSales);
        const totalSales = salesResult.rows.reduce((sum, item) => sum + parseFloat(item.total), 0);


        // 2. Get Payments (Raw)
        const paymentsQuery = `
          SELECT 
            p.id as payment_id,
            p.payment_date,
            p.amount,
            p.payment_method,
            p.reference_number,
            p.order_id,
            o.order_number
          FROM payments p
          LEFT JOIN orders o ON p.order_id = o.id
          WHERE DATE(p.payment_date) = $1 AND p.status = 'completed'
          ORDER BY p.payment_date DESC
        `;
        const paymentsResult = await pool.query(paymentsQuery, [targetDate]);
        const totalCollected = paymentsResult.rows.reduce((sum, p) => sum + parseFloat(p.amount), 0);

        const paymentDetails = paymentsResult.rows.map(p => ({
            ...p,
            amount: parseFloat(p.amount)
        }));

        // 3. Get Pending Inventory (Stock)
        // We assume 'supplier' column in products matches 'id' in suppliers table. 
        // If it's a string name, the join might fail or we need to adjust.
        // Based on previous code analysis, 'supplier' in products seems to be an ID/FK.
        const inventoryQuery = `
            SELECT 
                p.id,
                p.name as product_name,
                p.stock,
                s.name as supplier_name
            FROM products p
            LEFT JOIN suppliers s ON p.supplier = s.id::text
            WHERE p.stock > 0
            ORDER BY s.name, p.name
        `;
        const inventoryResult = await pool.query(inventoryQuery);

        // Group Inventory by Supplier
        const groupedInventory = inventoryResult.rows.reduce((acc, item) => {
            const supplierName = item.supplier_name || 'Sin Proveedor';
            if (!acc[supplierName]) {
                acc[supplierName] = {
                    supplier_name: supplierName,
                    items: [],
                    total_items: 0
                };
            }
            acc[supplierName].items.push({
                product_name: item.product_name,
                stock: parseInt(item.stock)
            });
            acc[supplierName].total_items += parseInt(item.stock);
            return acc;
        }, {});
        const inventoryDetails = Object.values(groupedInventory).sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));


        res.json({
            success: true,
            data: {
                date: targetDate,
                total_sales: totalSales,
                total_collected: totalCollected,
                details: salesDetails,
                payment_details: paymentDetails,
                inventory_details: inventoryDetails
            }
        });

    } catch (error) {
        console.error('Error fetching register summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/register/close - Close the register
router.post('/close', async (req, res) => {
    const client = await pool.connect();
    try {
        const { total_sales, details, payment_details, inventory_details, notes, user_id } = req.body;

        await client.query('BEGIN');

        // Store both sales and payments in the details column
        // We use a structured object now. Legacy records are just arrays (sales).
        const compositeDetails = {
            sales: details,
            payments: payment_details,
            inventory: inventory_details
        };

        const insertQuery = `
      INSERT INTO register_closures (
        total_sales, details, notes, user_id, closing_date
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *
    `;

        const result = await client.query(insertQuery, [
            total_sales,
            JSON.stringify(compositeDetails),
            notes,
            user_id
        ]);

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            data: result.rows[0],
            message: 'Caja cerrada correctamente'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error closing register:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        client.release();
    }
});

// GET /api/register/history - Get past closures
router.get('/history', async (req, res) => {
    try {
        const query = `
      SELECT rc.*, u.full_name as user_name
      FROM register_closures rc
      LEFT JOIN users u ON rc.user_id = u.id
      ORDER BY rc.closing_date DESC
    `;

        const result = await pool.query(query);

        res.json({
            success: true,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching register history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/register/history/:id - Delete a closure record
router.delete('/history/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const query = 'DELETE FROM register_closures WHERE id = $1 RETURNING *';
        const result = await pool.query(query, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'Closure record not found' });
        }

        res.json({
            success: true,
            message: 'Registro de cierre eliminado correctamente'
        });
    } catch (error) {
        console.error('Error deleting register history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
