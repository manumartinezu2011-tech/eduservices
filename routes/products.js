const express = require('express')
const { body, validationResult } = require('express-validator')
const { Pool } = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

const router = express.Router()

// Validation middleware
const validateProduct = [
  body('name').notEmpty().withMessage('El nombre es requerido'),
  body('sku').notEmpty().withMessage('El SKU es requerido'),
  body('price').isFloat({ min: 0 }).withMessage('El precio debe ser un número positivo'),
  body('stock').isInt({ min: 0 }).withMessage('El stock debe ser un número entero positivo'),
  body('min_stock').isInt({ min: 0 }).withMessage('El stock mínimo debe ser un número entero positivo'),
  body('unit').notEmpty().withMessage('La unidad es requerida')
]

// GET /api/products - Obtener todos los productos con categorías
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.category_id,
        c.slug as category,
        c.name as category_name,
        c.color as category_color,
        p.sku,
        p.description,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        p.supplier,
        p.expiry_date,
        p.image_url as image,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ORDER BY p.name
    `)
    
    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching products:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/products/:id - Obtener un producto por ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.category_id,
        c.slug as category,
        c.name as category_name,
        c.color as category_color,
        p.sku,
        p.description,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        p.supplier,
        p.expiry_date,
        p.image_url as image,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }
    
    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching product:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// POST /api/products - Crear nuevo producto
router.post('/', validateProduct, async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const {
      name,
      category_id,
      sku,
      description,
      price,
      cost,
      stock,
      min_stock,
      unit,
      supplier,
      expiry_date,
      image_url
    } = req.body

    // Check if SKU already exists
    const existingSku = await pool.query('SELECT id FROM products WHERE sku = $1', [sku])
    if (existingSku.rows.length > 0) {
      return res.status(400).json({ error: 'El SKU ya existe' })
    }

    const result = await pool.query(`
      INSERT INTO products (
        name, category_id, sku, description, price, cost, stock, 
        min_stock, unit, supplier, expiry_date, image_url
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      ) RETURNING *
    `, [
      name, category_id, sku, description, price, cost || 0, stock,
      min_stock, unit, supplier, expiry_date, image_url
    ])

    // Fetch the created product with category info
    const createdProduct = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.category_id,
        c.slug as category,
        c.name as category_name,
        c.color as category_color,
        p.sku,
        p.description,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        p.supplier,
        p.expiry_date,
        p.image_url as image,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [result.rows[0].id])

    res.status(201).json(createdProduct.rows[0])
  } catch (error) {
    console.error('Error creating product:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// PUT /api/products/:id - Actualizar producto
router.put('/:id', validateProduct, async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const { id } = req.params
    const {
      name,
      category_id,
      sku,
      description,
      price,
      cost,
      stock,
      min_stock,
      unit,
      supplier,
      expiry_date,
      image_url
    } = req.body

    // Check if product exists
    const existingProduct = await pool.query('SELECT id FROM products WHERE id = $1', [id])
    if (existingProduct.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    // Check if SKU already exists for another product
    const existingSku = await pool.query('SELECT id FROM products WHERE sku = $1 AND id != $2', [sku, id])
    if (existingSku.rows.length > 0) {
      return res.status(400).json({ error: 'El SKU ya existe para otro producto' })
    }

    await pool.query(`
      UPDATE products SET
        name = $1,
        category_id = $2,
        sku = $3,
        description = $4,
        price = $5,
        cost = $6,
        stock = $7,
        min_stock = $8,
        unit = $9,
        supplier = $10,
        expiry_date = $11,
        image_url = $12,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $13
    `, [
      name, category_id, sku, description, price, cost || 0, stock,
      min_stock, unit, supplier, expiry_date, image_url, id
    ])

    // Fetch the updated product with category info
    const updatedProduct = await pool.query(`
      SELECT 
        p.id,
        p.name,
        p.category_id,
        c.slug as category,
        c.name as category_name,
        c.color as category_color,
        p.sku,
        p.description,
        p.price,
        p.cost,
        p.stock,
        p.min_stock,
        p.unit,
        p.supplier,
        p.expiry_date,
        p.image_url as image,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `, [id])

    res.json(updatedProduct.rows[0])
  } catch (error) {
    console.error('Error updating product:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// DELETE /api/products/:id - Eliminar producto
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [id])
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    res.json({ message: 'Producto eliminado correctamente', product: result.rows[0] })
  } catch (error) {
    console.error('Error deleting product:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// PATCH /api/products/:id/stock - Actualizar solo el stock
router.patch('/:id/stock', async (req, res) => {
  try {
    const { id } = req.params
    const { quantity } = req.body

    if (typeof quantity !== 'number') {
      return res.status(400).json({ error: 'La cantidad debe ser un número' })
    }

    const result = await pool.query(`
      UPDATE products 
      SET stock = GREATEST(0, stock + $1), updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING stock
    `, [quantity, id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' })
    }

    res.json({ message: 'Stock actualizado', newStock: result.rows[0].stock })
  } catch (error) {
    console.error('Error updating stock:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/products/categories - Obtener todas las categorías
router.get('/categories/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY name')
    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching categories:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router