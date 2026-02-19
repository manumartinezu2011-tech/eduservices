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
const validateUnit = [
  body('name').notEmpty().withMessage('El nombre es requerido'),
  body('symbol').notEmpty().withMessage('El símbolo es requerido'),
  body('type').isIn(['weight', 'volume', 'length', 'unit']).withMessage('El tipo debe ser weight, volume, length o unit')
]

// GET /api/units - Obtener todas las unidades
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        symbol,
        description,
        type,
        created_at,
        updated_at
      FROM units
      WHERE deleted_at IS NULL
      ORDER BY type, name
    `)

    res.json(result.rows)
  } catch (error) {
    console.error('Error fetching units:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/units/:id - Obtener una unidad por ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const result = await pool.query(`
      SELECT
        id,
        name,
        symbol,
        description,
        type,
        created_at,
        updated_at
      FROM units
      WHERE id = $1 AND deleted_at IS NULL
    `, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Unidad no encontrada' })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching unit:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/units/symbol/:symbol - Obtener unidad por símbolo
router.get('/symbol/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params
    const result = await pool.query(`
      SELECT
        id,
        name,
        symbol,
        description,
        type,
        created_at,
        updated_at
      FROM units
      WHERE symbol = $1 AND deleted_at IS NULL
    `, [symbol])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Unidad no encontrada' })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching unit by symbol:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/units/usage/:symbol - Obtener uso de una unidad (productos que la usan)
router.get('/usage/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM products
      WHERE unit = $1 AND deleted_at IS NULL
    `, [symbol])

    res.json({
      symbol,
      count: parseInt(result.rows[0].count) || 0
    })
  } catch (error) {
    console.error('Error fetching unit usage:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// POST /api/units - Crear nueva unidad
router.post('/', validateUnit, async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const { name, symbol, description, type } = req.body

    // Check if symbol already exists
    const existingSymbol = await pool.query(
      'SELECT id FROM units WHERE symbol = $1 AND deleted_at IS NULL',
      [symbol]
    )
    if (existingSymbol.rows.length > 0) {
      return res.status(400).json({ error: 'El símbolo ya existe' })
    }

    const result = await pool.query(`
      INSERT INTO units (name, symbol, description, type)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [name, symbol, description || null, type])

    res.status(201).json(result.rows[0])
  } catch (error) {
    console.error('Error creating unit:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// PUT /api/units/:id - Actualizar unidad
router.put('/:id', validateUnit, async (req, res) => {
  try {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() })
    }

    const { id } = req.params
    const { name, symbol, description, type } = req.body

    // Check if unit exists
    const existingUnit = await pool.query(
      'SELECT id, symbol FROM units WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )
    if (existingUnit.rows.length === 0) {
      return res.status(404).json({ error: 'Unidad no encontrada' })
    }

    // Check if symbol already exists for another unit
    const existingSymbol = await pool.query(
      'SELECT id FROM units WHERE symbol = $1 AND id != $2 AND deleted_at IS NULL',
      [symbol, id]
    )
    if (existingSymbol.rows.length > 0) {
      return res.status(400).json({ error: 'El símbolo ya existe para otra unidad' })
    }

    // If symbol is being changed, check if it's being used by products
    const oldSymbol = existingUnit.rows[0].symbol
    if (oldSymbol !== symbol) {
      const productsUsingUnit = await pool.query(
        'SELECT COUNT(*) as count FROM products WHERE unit = $1 AND deleted_at IS NULL',
        [oldSymbol]
      )
      if (parseInt(productsUsingUnit.rows[0].count) > 0) {
        return res.status(400).json({
          error: 'No se puede cambiar el símbolo de una unidad que está siendo usada por productos. Primero actualice los productos.'
        })
      }
    }

    const result = await pool.query(`
      UPDATE units SET
        name = $1,
        symbol = $2,
        description = $3,
        type = $4,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [name, symbol, description || null, type, id])

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error updating unit:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// DELETE /api/units/:id - Eliminar unidad (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params

    // Check if unit exists
    const existingUnit = await pool.query(
      'SELECT id, symbol FROM units WHERE id = $1 AND deleted_at IS NULL',
      [id]
    )
    if (existingUnit.rows.length === 0) {
      return res.status(404).json({ error: 'Unidad no encontrada' })
    }

    // Check if unit is being used by products
    const symbol = existingUnit.rows[0].symbol
    const productsUsingUnit = await pool.query(
      'SELECT COUNT(*) as count FROM products WHERE unit = $1 AND deleted_at IS NULL',
      [symbol]
    )

    const productCount = parseInt(productsUsingUnit.rows[0].count) || 0
    if (productCount > 0) {
      return res.status(400).json({
        error: `No se puede eliminar esta unidad porque tiene ${productCount} producto(s) asociado(s)`
      })
    }

    // Soft delete
    const result = await pool.query(`
      UPDATE units
      SET deleted_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id])

    res.json({
      message: 'Unidad eliminada correctamente',
      unit: result.rows[0]
    })
  } catch (error) {
    console.error('Error deleting unit:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

// GET /api/units/stats - Obtener estadísticas de unidades
router.get('/stats/summary', async (req, res) => {
  try {
    const totalResult = await pool.query(
      'SELECT COUNT(*) as total FROM units WHERE deleted_at IS NULL'
    )

    const usageResult = await pool.query(`
      SELECT u.symbol, COUNT(p.id) as product_count
      FROM units u
      LEFT JOIN products p ON u.symbol = p.unit AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
      GROUP BY u.symbol
      HAVING COUNT(p.id) > 0
    `)

    const totalProductsResult = await pool.query(
      'SELECT COUNT(*) as total FROM products WHERE deleted_at IS NULL'
    )

    res.json({
      total_units: parseInt(totalResult.rows[0].total) || 0,
      units_in_use: usageResult.rows.length,
      total_products: parseInt(totalProductsResult.rows[0].total) || 0,
      usage_by_unit: usageResult.rows
    })
  } catch (error) {
    console.error('Error fetching units stats:', error)
    res.status(500).json({ error: 'Error interno del servidor' })
  }
})

module.exports = router
