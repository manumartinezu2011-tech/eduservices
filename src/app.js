require('dotenv').config();
const express = require('express');
const cors = require('cors');
const productosRoutes = require('./routes/productos');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Rutas
app.use('/api/productos', productosRoutes);

// Iniciar servidor
app.listen(3002, '0.0.0.0', () => {
  console.log(`Servidor corriendo en el puerto 3002 (accesible desde la red local)`);
});