const express = require('express');
const cors = require('cors');
const pool = require('./controllers/db'); // Asegúrate de que la ruta sea correcta

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/pedidos', async (req, res) => {
  const { producto, precio, cantidad, comentario } = req.body;
  const [result] = await pool.query(
    'INSERT INTO pedidos SET ?', 
    { producto, precio, cantidad, comentario, fecha: new Date() }
  );
  res.json({ success: true, id: result.insertId });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Servidor en puerto 3001'));