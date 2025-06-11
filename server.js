// server.js
require('dotenv').config();
const express = require('express');
const app = express();
const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = process.env;

app.get('/', (req, res) => {
    const authURL = `https://auth.mercadolibre.com.co/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`;
    res.send(`
        <h1>Conectar con Mercado Libre</h1>
        <a href="${authURL}">Conectar</a>
    `);
});

app.get('/callback', async (req, res) => {
    res.send("✅ Callback recibido. Procesa el token aquí.");
});


app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});
