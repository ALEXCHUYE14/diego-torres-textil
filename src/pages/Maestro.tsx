import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { obtenerTodasLasFilas, supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { DataTable, PageHeader } from '../components/ui';
import { Familia, Producto } from '../lib/types';
import { moneda, numero, soloFecha } from '../utils/format';
import { filtrarProductos } from '../utils/busqueda';

// Vista de solo lectura, disponible para los 3 roles (incluido Consulta):
// listado completo del catálogo con búsqueda instantánea por nombre,
// código, familia, color o talla. No tiene ninguna acción de edición —
// para eso está la página Artículos.
export default function Maestro() {
  const { toast } = useToast();
  const [productos, setProductos] = useState<Producto[]>([]);
  const [familias, setFamilias] = useState<Familia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [busqueda, setBusqueda] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Sin paginar, Supabase tapa la consulta en 1000 filas — con un
        // catálogo ya grande, artículos que caen después de ese corte
        // alfabético (ej. una tela que empieza con "T") nunca llegaban al
        // navegador y por eso el buscador nunca los encontraba, aunque sí
        // existieran en la base de datos.
        const [p, { data: f, error: e2 }] = await Promise.all([
          obtenerTodasLasFilas<Producto>((desde, hasta) =>
            supabase.from('productos').select('*').order('nombre').range(desde, hasta)
          ),
          supabase.from('familias').select('*').order('codigo'),
        ]);
        if (e2) { toast('error', 'No se pudo cargar el listado maestro de productos'); return; }
        setProductos(p);
        setFamilias((f as Familia[]) ?? []);
      } catch {
        toast('error', 'Error de red al cargar el listado. Verifique su conexión.');
      } finally {
        setCargando(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nombreFamilia = useMemo(() => {
    const mapa = new Map(familias.map((f) => [f.id_familia, f.nombre]));
    return (id: string) => mapa.get(id) ?? '—';
  }, [familias]);

  // useDeferredValue: evita que el filtrado de un catálogo grande bloquee el
  // tecleo — misma razón que en Articulos.tsx.
  const busquedaDiferida = useDeferredValue(busqueda);
  const filtrados = useMemo(
    // filtrarProductos (src/utils/busqueda.ts): búsqueda por palabras,
    // insensible a tildes/mayúsculas, con fallback a coincidencia parcial —
    // misma lógica en todo el sistema (Articulos.tsx, BuscadorProducto).
    () => filtrarProductos(productos, busquedaDiferida, (p) => [nombreFamilia(p.id_familia)]),
    [productos, busquedaDiferida, nombreFamilia]
  );

  // Exporta exactamente lo que está en pantalla (respeta la búsqueda activa):
  // si hay un filtro escrito, descarga solo esas filas; si no, descarga todo
  // el catálogo. Valores numéricos sin formatear (sin "S/" ni separadores de
  // miles) para que Excel/Sheets los reconozca como números, no como texto.
  const descargarCSV = () => {
    const encabezados = ['Código', 'Nombre', 'Género', 'Color', 'Talla', 'Familia', 'Stock', 'CPP', 'Precio venta', 'Estado', 'Creado'];
    const escapar = (valor: string) => `"${valor.replace(/"/g, '""')}"`;
    const filas = filtrados.map((p) => [
      p.codigo_barra,
      p.nombre,
      p.genero ?? '',
      p.color ?? '',
      p.talla ?? '',
      nombreFamilia(p.id_familia),
      p.stock_real,
      p.costo_promedio_ponderado,
      p.precio_venta,
      p.activo ? 'Activo' : 'Inactivo',
      soloFecha(p.fecha_creacion),
    ].map((campo) => escapar(String(campo))).join(','));

    const csv = [encabezados.map(escapar).join(','), ...filas].join('\r\n');
    // BOM al inicio: sin esto, Excel abre acentos/ñ como caracteres corruptos.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = `maestro-productos-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(enlace);
    enlace.click();
    document.body.removeChild(enlace);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        titulo="Maestro de productos"
        subtitulo="Listado completo del catálogo · consulta rápida por nombre, código, familia, color o talla"
        extra={
          <button className="dt-btn dt-btn-ghost" onClick={descargarCSV} disabled={cargando || filtrados.length === 0}>
            <Download size={16} /> Descargar CSV
          </button>
        }
      />

      <div className="dt-card p-5 md:p-6">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-pizarra-400" />
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, código, familia, color o talla…"
            className="dt-input !pl-11"
            aria-label="Buscar en el maestro de productos"
            autoFocus
          />
        </div>
        <p className="mt-2 text-[12.5px] text-pizarra-400">
          {cargando ? 'Cargando…' : `${filtrados.length} de ${productos.length} artículo${productos.length === 1 ? '' : 's'}`}
        </p>
      </div>

      <div className="dt-card mt-6 p-5 md:p-6">
        <DataTable<Producto & Record<string, unknown>>
          columnas={[
            { clave: 'codigo_barra', titulo: 'Código', render: (p) => <span className="font-mono text-[12.5px] text-indigo-600">{p.codigo_barra}</span> },
            { clave: 'nombre', titulo: 'Artículo', render: (p) => [p.nombre, p.genero, p.color, p.talla].filter(Boolean).join(' · ') },
            { clave: 'id_familia', titulo: 'Familia', render: (p) => nombreFamilia(p.id_familia) },
            { clave: 'stock_real', titulo: 'Stock', numerica: true, render: (p) => numero(p.stock_real) },
            { clave: 'costo_promedio_ponderado', titulo: 'CPP', numerica: true, render: (p) => moneda(p.costo_promedio_ponderado) },
            { clave: 'precio_venta', titulo: 'Precio venta', numerica: true, render: (p) => moneda(p.precio_venta) },
            { clave: 'activo', titulo: 'Estado', render: (p) => (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${p.activo ? 'bg-emerald-50 text-emerald-600' : 'bg-pizarra-100 text-pizarra-500'}`}>
                {p.activo ? 'Activo' : 'Inactivo'}
              </span>
            )},
            { clave: 'fecha_creacion', titulo: 'Creado', render: (p) => <span className="text-pizarra-500">{soloFecha(p.fecha_creacion)}</span> },
          ]}
          filas={filtrados as Array<Producto & Record<string, unknown>>}
          porPagina={12}
          vacio={cargando ? 'Cargando…' : 'Sin artículos que coincidan con la búsqueda'}
          idDeFila={(p) => p.id_producto}
        />
      </div>
    </div>
  );
}
