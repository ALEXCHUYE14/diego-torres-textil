# Diego Torres · Inventario, POS y CRM Textil

Sistema integral para empresa del sector textil: entradas y salidas de almacén con costo promedio ponderado, codificación automática de artículos, punto de venta con ticket térmico de 80mm, kardex con KPIs financieros, informe de cierre con exportación a PDF e impresión centralizada de documentos.

**Stack:** React 18 · TypeScript · Vite · Tailwind CSS · Supabase (Auth + PostgreSQL + RLS) · jsPDF

## 1. Configurar Supabase

1. Cree un proyecto en [supabase.com](https://supabase.com).
2. Abra **SQL Editor** y ejecute completo el archivo `supabase/schema.sql`. Esto crea tablas, funciones RPC transaccionales, políticas RLS y los datos semilla (familias textiles 01000–15000 y proveedores demo).
3. En **Authentication → Providers**, verifique que Email esté habilitado.
4. Cree su primer usuario en **Authentication → Users → Add user** (correo + contraseña). El trigger le asigna automáticamente el rol `consulta`.
5. Para darle rol operativo (escritura), ejecute en SQL Editor:

```sql
update usuarios set rol = 'operativo'
where id_usuario = (select id from auth.users where email = 'SU_CORREO');
```

## 2. Configurar el frontend

```bash
cp .env.example .env
# Edite .env con la URL del proyecto y la anon key (Settings → API)
npm install
npm run dev        # desarrollo → http://localhost:5173
npm run build      # producción → carpeta dist/
```

## 3. Roles

| Rol | Permisos |
|---|---|
| `consulta` | Solo lectura en todos los módulos (RLS lo bloquea también a nivel de base de datos) |
| `operativo` | Lectura y escritura: entradas, salidas, ventas, artículos, clientes |

## 4. Módulos

- **Informe de cierre** (`/`): filtros de fecha, KPIs de volumen y financieros, valor de inventario retrospectivo, grid ordenable con paginación y botón Generar PDF.
- **Entradas** (`/entradas`): consecutivo ENT automático, tipos 1000/1002/1007/1210, calendario restringido al mes actual del servidor (validado también en la RPC), proveedor con NIT/correo/teléfono en solo lectura, total reactivo.
- **Salidas** (`/salidas`): consecutivo SAL automático, tipos 2000/2003, bloqueo en tiempo real si la cantidad supera el stock (toast rojo), valor de solo lectura calculado por costo promedio ponderado. La RPC usa `FOR UPDATE` para impedir stocks negativos incluso con usuarios simultáneos.
- **Artículos** (`/articulos`): codificación en vivo `FAMILIA-CONSECUTIVO-NOMBRE-GENERO-COLOR-TALLA` con contador por familia bloqueado a nivel de fila (anti-colisión), barra Agregar / Editar / Eliminar / Guardar y modal de confirmación.
- **POS** (`/pos`): venta táctil multi-ítem, clientes CRM (alta rápida), métodos de pago, ticket térmico de 80mm vía `@media print` con tipografía monoespaciada y zona de alimentación para el corte térmico.
- **Kardex** (`/kardex`): detalle maestro con 10 KPIs, alerta "(Producto no encontrado)", filtros Kardex Mes / Año / Años anteriores con selector de año histórico y validación estricta de fechas nulas o basura (30/12/1899).
- **Imprimir** (botón global): modal Tipo + N° Documento que consulta Supabase y genera el PDF correspondiente.

## 5. Impresión térmica 80mm

La vista de impresión fija el ancho de página a 80mm sin márgenes del navegador. Configure la impresora POS con su driver nativo (corte automático al finalizar el trabajo); la zona inferior del ticket alimenta papel suficiente antes del corte.

## 6. Estructura

```
supabase/schema.sql        Base de datos completa (tablas, RPCs, RLS, seeds)
src/
  lib/        supabase.ts (cliente) · types.ts (dominio)
  context/    AuthContext (sesión + rol) · ToastContext
  components/ Layout (sidebar/bottom-nav) · PrintModal · ui.tsx (tabla, buscador, modales, KPIs)
  pages/      Dashboard · Entradas · Salidas · Articulos · POS · Kardex · Login
  utils/      format.ts (moneda PEN, fechas seguras, límites del mes)
```
