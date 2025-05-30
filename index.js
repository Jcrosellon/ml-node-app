require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const { saveTokenToDB, getLatestTokenFromDB, saveOrder, saveItems, saveTaxes, clearAllOrderData } = require('./db');
const { DateTime } = require('luxon');

app.set('view engine', 'ejs');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let tokens = {};

app.get('/', (req, res) => {
    const authURL = `https://auth.mercadolibre.com.co/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`;

    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <title>Conectar con Mercado Libre</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(145deg, #ffe600, #fffde7);
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          text-align: center;
        }
        .btn {
          background-color: #3483fa;
          color: white;
          padding: 16px 32px;
          font-size: 18px;
          text-decoration: none;
          border-radius: 8px;
          transition: background-color 0.3s ease;
        }
        .btn:hover {
          background-color: #2968c8;
        }
        h1 {
          margin-bottom: 30px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Autenticación con Mercado Libre</h1>
        <a href="${authURL}" class="btn">🔐 Conectar con Mercado Libre</a>
      </div>
    </body>
    </html>
  `);
});


app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No se recibió código");

    try {
        const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        tokens = response.data;
        await saveTokenToDB(tokens.access_token);

        res.redirect('/orders');
    } catch (err) {
        console.error(err);
        res.send("Error al obtener el token");
    }
});

app.get('/orders', async (req, res) => {
    try {
        const access_token = await getLatestTokenFromDB();
        if (!access_token) {
            return res.send("No se encontró ningún token válido.");
        }

        // 💣 Limpiar toda la base antes de guardar nuevas órdenes
        await clearAllOrderData();

        // Calcular rango de fechas
        const days = parseInt(req.query.days) || 30;
        const desde = new Date();
        desde.setDate(desde.getDate() - days);
        const hasta = new Date();

        const isoDateFrom = desde.toISOString();
        const isoDateTo = hasta.toISOString();

        let allOrders = [];

        const limit = 50;
        let offset = 0;

        // ✅ Ubica esto DESPUÉS del while
        while (true) {
            const paginatedURL = `https://api.mercadolibre.com/orders/search?seller=${tokens.user_id}&date_created.from=${isoDateFrom}&date_created.to=${isoDateTo}&sort=date_desc&limit=${limit}&offset=${offset}`;
            const response = await axios.get(paginatedURL, {
                headers: { Authorization: `Bearer ${access_token}` }
            });

            const currentOrders = response.data.results;
            if (!currentOrders.length) break;

            allOrders.push(...currentOrders);
            if (currentOrders.length < limit) break;
            offset += limit;
        }

        // ✅ AQUI SÍ DEBES FILTRAR
        allOrders = allOrders.filter(order => {
            const created = new Date(order.date_created);
            return created >= desde && created <= hasta;
        });
        // 💡 Evita sobrecarga en tiempo de desarrollo
        allOrders = allOrders.slice(0, 500); // <-- prueba con 30 o 50 primero
        const totalOrders = allOrders.length;

        const orders = await Promise.all(allOrders.map(async (order, i) => {
            const buyerName = typeof order.buyer === 'object'
                ? order.buyer.nickname || order.buyer.first_name || order.buyer.name || 'Desconocido'
                : 'Desconocido';

            const totalNumber = order.total_amount || 0;

            let dateCreated = null;
            let cargosPorVenta = 0;
            let fullOrder = null;

            try {
                const debugRes = await axios.get(`https://api.mercadolibre.com/orders/${order.id}`, {
                    headers: { Authorization: `Bearer ${access_token}` }
                });

                fullOrder = debugRes.data;

                dateCreated = DateTime.fromISO(fullOrder.date_created)
                    .setZone('America/Bogota')
                    .startOf('minute')
                    .toJSDate();

                cargosPorVenta = Array.isArray(fullOrder.payments)
                    ? fullOrder.payments.reduce((sum, p) => sum + (p.marketplace_fee || 0), 0)
                    : 0;

                // console.log(`🧾 Orden ${order.id} - Cargos por venta: ${cargosPorVenta}`);
            } catch (err) {
                // console.warn(`⚠️ Error al hacer debug GET /orders/${order.id}`);
            }

            const total = totalNumber.toLocaleString('es-CO', { style: 'currency', currency: 'COP' });

            const taxes = [
                { name: 'Retención ICA', value: totalNumber * 0.009 },
                { name: 'Retención Fuente', value: totalNumber * 0.025 },
                { name: 'ReteIVA (15%)', value: totalNumber * 0.15 }
            ];

            // ✅ NUEVO CÓDIGO para obtener únicamente tu SKU personalizado
            const items = [];

            if (Array.isArray(order.order_items)) {
                for (const i of order.order_items) {
                    const itemId = i.item?.id;
                    let skuMeli = '⚠️ No definido por el vendedor';
                    let skuVendedor = '⚠️ No especificado en atributos';

                    if (itemId) {
                        try {
                            const itemRes = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, {
                                headers: { Authorization: `Bearer ${access_token}` }
                            });

                            const skuAttr = itemRes.data.attributes.find(a => a.id === 'SELLER_SKU');
                            skuVendedor = skuAttr?.value_name || '⚠️ No especificado en atributos';

                            skuMeli = itemRes.data.seller_custom_field || '⚠️ No definido por el vendedor';

                            console.log(`📦 Item ${itemId}: SKU vendedor = ${skuVendedor}, SKU ML = ${skuMeli}`);
                        } catch (err) {
                            console.warn(`⚠️ No se pudo obtener info para item ${itemId}: ${err.message}`);
                        }
                    }

                    items.push({
                        sku: skuVendedor,        // lo que pones tú (SKU manual)
                        sku_meli: itemId,        // lo que pone Mercado Libre (item.id)
                        title: i.item?.title || 'Sin título',
                        quantity: i.quantity || 0,
                        unit_price: i.unit_price?.toString() || '0'
                    });

                }

            }



            const itemSKUs = items.length > 0 ? items.map(i => i.sku).join(', ') : 'Sin productos';


            let billingInfo = {
                name: 'No disponible',
                id_type: 'No disponible',
                id_number: 'No disponible',
                address: 'No disponible',
            };

            try {
                const billingRes = await axios.get(`https://api.mercadolibre.com/orders/${order.id}/billing_info`, {
                    headers: { Authorization: `Bearer ${access_token}`, 'x-version': '2' }
                });

                const info = billingRes.data?.buyer?.billing_info;
                if (info && info.identification && info.address) {
                    billingInfo = {
                        name: [info.name, info.last_name].filter(Boolean).join(' ').trim() || 'Desconocido',
                        id_type: info?.identification?.type || 'Desconocido',
                        id_number: info?.identification?.number || 'Desconocido',
                        address: [
                            info?.address?.street_name,
                            info?.address?.street_number,
                            info?.address?.city_name
                        ].filter(Boolean).join(' ').trim() || 'Sin dirección'
                    };
                }
            } catch (err) {
                // console.warn(`⚠️ No se pudo obtener billing_info para la orden ${order.id}`);
            }

            let costoEnvio = 0;
            let ciudad = null;

            try {
                const shippingRes = await axios.get(`https://api.mercadolibre.com/shipments/${order.shipping?.id}`, {
                    headers: { Authorization: `Bearer ${access_token}` }
                });

                costoEnvio = shippingRes.data.base_cost || 0;
                ciudad = shippingRes.data.receiver_address?.city?.name || null;
            } catch (err) {
                // console.warn(`⚠️ No se pudo obtener envío para la orden ${order.id}`);
            }

            await saveOrder({
                id: order.id,
                status: order.status,
                date_created: dateCreated,
                buyer_name: buyerName,
                nombre_cliente: billingInfo.name,
                buyer_id_type: billingInfo.id_type,
                buyer_id_number: billingInfo.id_number,
                buyer_address: billingInfo.address,
                cargos_por_venta: cargosPorVenta,
                costoEnvio,
                ciudad
            });

            await saveItems(order.id, items);
            await saveTaxes(order.id, taxes);

            // console.log(`✅ Orden ${order.id} guardada con éxito en la base de datos.`);

            return {
                invoiceNumber: offset + i + 1,
                id: order.id,
                status: order.status,
                buyer: buyerName,
                date: new Date(order.date_created).toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
                total,
                skus: itemSKUs,
                items,
                taxes,
                billingInfo,
                costoEnvio,
                cargosPorVenta
            };
        }));


        const query = req.query.q || '';

        let filteredOrders = orders;

        if (query) {
            filteredOrders = orders.filter(order =>
                order.id.toString().includes(query) ||
                order.buyer.toLowerCase().includes(query) ||
                order.billingInfo.name.toLowerCase().includes(query)
            );
        }



        const page = parseInt(req.query.page) || 1;
        const perPage = 50; // Número de órdenes por página
        const totalPages = Math.ceil(orders.length / perPage);
        const start = (page - 1) * perPage;
        const end = start + perPage;
        const paginatedOrders = orders.slice(start, end);

        res.render('orders', {
            orders: paginatedOrders,
            page,
            totalPages,
            query,
            days
        });



    } catch (err) {
        console.error("❌ Error en /orders:", err.message || err);
        res.status(500).send("Error al obtener órdenes: " + (err.message || 'Error desconocido'));
    }

});



app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});
