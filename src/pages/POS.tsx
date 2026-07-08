import { useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Printer, ShoppingBag, Trash2, UserPlus, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { BuscadorProducto, PageHeader } from '../components/ui';
import { Cliente, ItemCarrito, Producto } from '../lib/types';
import { moneda, numero } from '../utils/format';
import { borrarBorrador, CLAVE_CARRITO_POS, guardarBorrador, leerBorrador } from '../utils/borrador';

interface BorradorPOS {
  carrito: ItemCarrito[];
  clienteId: string;
  metodo: string;
}

interface TicketData {
  nro_ticket: string;
  fecha: Date;
  items: ItemCarrito[];
  total: number;
  cliente: Cliente | null;
  metodo: string;
}

export default function POS() {
  const { toast } = useToast();
  const { esOperativo, session } = useAuth();
  const uid = session?.user.id ?? '';
  const buscadorRef = useRef<HTMLInputElement>(null);
  const restaurado = useRef(false);

  const [carrito, setCarrito] = useState<ItemCarrito[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [metodo, setMetodo] = useState('EFECTIVO');
  const [nuevoCliente, setNuevoCliente] = useState(false);
  const [ncDoc, setNcDoc] = useState('');
  const [ncNombre, setNcNombre] = useState('');
  const [ncTelefono, setNcTelefono] = useState('');
  const [procesando, setProcesando] = useState(false);
  const [ticket, setTicket] = useState<TicketData | null>(null);

  const total = useMemo(
    () => carrito.reduce((s, i) => s + i.cantidad * (i.producto.precio_venta || i.producto.costo_promedio_ponderado), 0),
    [carrito]
  );

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.from('clientes').select('*').order('nombre');
        if (error) { toast('error', 'No se pudo cargar la lista de clientes'); return; }
        setClientes((data as Cliente[]) ?? []);
      } catch {
        toast('error', 'Error de red al cargar clientes. Verifique su conexión.');
      }
    })();
  }, [toast]);

  // Restaura el carrito (si existe y pertenece al usuario actual) una vez
  // que la lista de clientes ya cargó, para poder resolver el id guardado.
  useEffect(() => {
    if (!uid || restaurado.current || clientes.length === 0) return;
    restaurado.current = true;
    const b = leerBorrador<BorradorPOS>(CLAVE_CARRITO_POS, uid);
    if (!b || b.carrito.length === 0) return;
    setCarrito(b.carrito);
    setCliente(clientes.find((c) => c.id_cliente === b.clienteId) ?? null);
    setMetodo(b.metodo);
    toast('aviso', 'Se restauró el ticket que quedó sin cobrar');
  }, [uid, clientes, toast]);

  // Persiste el ticket en curso para sobrevivir a un F5 accidental
  useEffect(() => {
    if (!uid) return;
    if (carrito.length === 0) { borrarBorrador(CLAVE_CARRITO_POS); return; }
    const b: BorradorPOS = { carrito, clienteId: cliente?.id_cliente ?? '', metodo };
    guardarBorrador(CLAVE_CARRITO_POS, uid, b);
  }, [uid, carrito, cliente, metodo]);

  const agregarProducto = (p: Producto) => {
    if (p.stock_real <= 0) { toast('error', `Sin stock: ${p.nombre}`); return; }
    setCarrito((c) => {
      const existente = c.find((i) => i.producto.id_producto === p.id_producto);
      if (existente) {
        if (existente.cantidad + 1 > p.stock_real) {
          toast('error', `Stock insuficiente: disponible ${numero(p.stock_real)}`);
          return c;
        }
        return c.map((i) => i.producto.id_producto === p.id_producto ? { ...i, cantidad: i.cantidad + 1 } : i);
      }
      return [...c, { producto: p, cantidad: 1 }];
    });
  };

  const cambiarCantidad = (id: string, delta: number) => {
    setCarrito((c) => c.flatMap((i) => {
      if (i.producto.id_producto !== id) return [i];
      const nueva = i.cantidad + delta;
      if (nueva <= 0) return [];
      if (nueva > i.producto.stock_real) {
        toast('error', `Stock insuficiente: disponible ${numero(i.producto.stock_real)}`);
        return [i];
      }
      return [{ ...i, cantidad: nueva }];
    }));
  };

  const guardarCliente = async () => {
    if (!ncDoc.trim() || !ncNombre.trim()) { toast('aviso', 'Documento y nombre son obligatorios'); return; }
    try {
      const { data, error } = await supabase
        .from('clientes')
        .insert({ documento: ncDoc.trim(), nombre: ncNombre.trim().toUpperCase(), telefono: ncTelefono.trim() || null })
        .select()
        .single();
      if (error) { toast('error', error.message); return; }
      const c = data as Cliente;
      setClientes((cs) => [...cs, c].sort((a, b) => a.nombre.localeCompare(b.nombre)));
      setCliente(c);
      setNuevoCliente(false);
      setNcDoc(''); setNcNombre(''); setNcTelefono('');
      toast('exito', 'Cliente registrado en el CRM');
    } catch {
      toast('error', 'Error de red al registrar el cliente. Verifique su conexión.');
    }
  };

  const cobrar = async () => {
    if (carrito.length === 0) { toast('aviso', 'Agregue prendas al ticket'); return; }
    setProcesando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_registrar_venta', {
        p_items: carrito.map((i) => ({ producto_id: i.producto.id_producto, cantidad: i.cantidad })),
        p_cliente_id: cliente?.id_cliente ?? null,
        p_metodo_pago: metodo,
      });
      if (error) {
        toast('error', error.message.includes('STOCK_INSUFICIENTE') ? 'Stock insuficiente en uno de los ítems. Revise el carrito.' : error.message);
        return;
      }
      const t: TicketData = {
        nro_ticket: data.nro_ticket,
        fecha: new Date(),
        items: carrito,
        total: data.total,
        cliente,
        metodo,
      };
      setTicket(t);
      setCarrito([]);
      setCliente(null);
      borrarBorrador(CLAVE_CARRITO_POS);
      toast('exito', `Venta registrada · ${data.nro_ticket}`);
      setTimeout(() => window.print(), 350);
    } catch {
      toast('error', 'Error de red al procesar la venta. El ticket sigue disponible, intente cobrar de nuevo.');
    } finally {
      setProcesando(false);
    }
  };

  return (
    <div>
      <PageHeader titulo="Punto de venta" subtitulo="Facturación rápida táctil · ticket térmico de 80mm" />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* -------- Búsqueda + carrito -------- */}
        <div className="dt-card p-5 md:p-6">
          <label className="dt-label">Agregar prenda</label>
          <BuscadorProducto onSeleccion={agregarProducto} inputRef={buscadorRef} autoFocus placeholder="Escanee o busque la prenda…" />

          <div className="mt-5 space-y-2.5">
            {carrito.length === 0 && (
              <div className="grid place-items-center rounded-xl border border-dashed border-pizarra-300 py-14 text-center">
                <ShoppingBag size={28} className="mb-2 text-pizarra-300" />
                <p className="text-[14px] text-pizarra-400">El ticket está vacío. Busque una prenda para comenzar.</p>
              </div>
            )}
            {carrito.map((i) => {
              const precio = i.producto.precio_venta || i.producto.costo_promedio_ponderado;
              return (
                <div key={i.producto.id_producto} className="flex items-center gap-3 rounded-xl border border-pizarra-200 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-pizarra-800">{i.producto.nombre}</p>
                    <p className="text-[12px] text-pizarra-500">
                      Talla {i.producto.talla} · {i.producto.color} · {moneda(precio)} c/u
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button className="grid h-9 w-9 place-items-center rounded-lg border border-pizarra-200 text-pizarra-600 transition hover:bg-pizarra-50 active:scale-95" onClick={() => cambiarCantidad(i.producto.id_producto, -1)} aria-label="Restar">
                      <Minus size={16} />
                    </button>
                    <span className="w-8 text-center font-mono text-[15px] font-bold tabular-nums">{i.cantidad}</span>
                    <button className="grid h-9 w-9 place-items-center rounded-lg border border-pizarra-200 text-pizarra-600 transition hover:bg-pizarra-50 active:scale-95" onClick={() => cambiarCantidad(i.producto.id_producto, 1)} aria-label="Sumar">
                      <Plus size={16} />
                    </button>
                  </div>
                  <p className="w-24 text-right font-mono text-[14px] font-bold tabular-nums">{moneda(i.cantidad * precio)}</p>
                  <button className="rounded-lg p-1.5 text-pizarra-300 transition hover:bg-borgona-50 hover:text-borgona-600" onClick={() => setCarrito((c) => c.filter((x) => x.producto.id_producto !== i.producto.id_producto))} aria-label="Quitar">
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* -------- Cliente (CRM) + cobro -------- */}
        <div className="space-y-5">
          <div className="dt-card p-5">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-[15px] font-bold text-pizarra-800">
                <UserRound size={17} className="text-indigo-600" /> Cliente
              </h3>
              <button className="dt-btn dt-btn-ghost !px-3 !py-1.5 !text-[13px]" onClick={() => setNuevoCliente((v) => !v)}>
                <UserPlus size={15} /> Nuevo
              </button>
            </div>
            {!nuevoCliente ? (
              <select className="dt-input mt-3" value={cliente?.id_cliente ?? ''}
                onChange={(e) => setCliente(clientes.find((c) => c.id_cliente === e.target.value) ?? null)}>
                <option value="">Público general</option>
                {clientes.map((c) => (
                  <option key={c.id_cliente} value={c.id_cliente}>{c.nombre} · {c.documento}</option>
                ))}
              </select>
            ) : (
              <div className="mt-3 space-y-3">
                <input className="dt-input font-mono" placeholder="DNI / RUC" value={ncDoc} onChange={(e) => setNcDoc(e.target.value)} />
                <input className="dt-input uppercase" placeholder="Nombre completo" value={ncNombre} onChange={(e) => setNcNombre(e.target.value)} />
                <input className="dt-input" placeholder="Teléfono (opcional)" value={ncTelefono} onChange={(e) => setNcTelefono(e.target.value)} />
                <button className="dt-btn dt-btn-primary w-full" onClick={guardarCliente}>Guardar cliente</button>
              </div>
            )}
            {cliente && !nuevoCliente && (
              <p className="mt-2.5 text-[12.5px] text-pizarra-500">
                {cliente.telefono ? `Tel: ${cliente.telefono} · ` : ''}Última compra: {cliente.ultima_compra ? new Date(cliente.ultima_compra).toLocaleDateString('es-PE') : 'primera vez'}
              </p>
            )}
          </div>

          <div className="dt-card p-5">
            <label className="dt-label">Método de pago</label>
            <div className="grid grid-cols-3 gap-2">
              {['EFECTIVO', 'YAPE', 'TARJETA'].map((m) => (
                <button key={m}
                  className={`rounded-[10px] border px-2 py-2.5 text-[13px] font-semibold transition ${metodo === m ? 'border-indigo-600 bg-indigo-600/10 text-indigo-600' : 'border-pizarra-200 text-pizarra-500 hover:border-pizarra-300'}`}
                  onClick={() => setMetodo(m)}>
                  {m}
                </button>
              ))}
            </div>
            <div className="costura my-5" />
            <div className="flex items-end justify-between">
              <span className="text-[13px] font-semibold uppercase tracking-wider text-pizarra-400">Total</span>
              <span className="text-[30px] font-extrabold tabular-nums text-pizarra-800">{moneda(total)}</span>
            </div>
            <button className="dt-btn dt-btn-primary mt-4 w-full !py-3.5 !text-[15px]" onClick={cobrar}
              disabled={procesando || carrito.length === 0 || !esOperativo}>
              <Printer size={18} /> {procesando ? 'Procesando…' : 'Cobrar e imprimir ticket'}
            </button>
            {ticket && (
              <button className="dt-btn dt-btn-ghost mt-2.5 w-full" onClick={() => window.print()}>
                Reimprimir {ticket.nro_ticket}
              </button>
            )}
            {!esOperativo && (
              <p className="mt-3 rounded-[10px] bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">
                Rol Consulta: la venta está deshabilitada.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ================= TICKET TÉRMICO 80mm (solo visible al imprimir) ================= */}
      {ticket && (
        <div className="ticket-80">
          <p className="t-center t-bold t-lg">DIEGO TORRES</p>
          <p className="t-center">Confección y venta textil</p>
          <p className="t-center">Catacaos · Piura · Perú</p>
          <div className="t-sep" />
          <table>
            <tbody>
              <tr><td>Ticket:</td><td className="t-right t-bold">{ticket.nro_ticket}</td></tr>
              <tr><td>Fecha:</td><td className="t-right">{ticket.fecha.toLocaleString('es-PE')}</td></tr>
              <tr><td>Pago:</td><td className="t-right">{ticket.metodo}</td></tr>
            </tbody>
          </table>
          <div className="t-sep" />
          <table>
            <tbody>
              {ticket.items.map((i) => {
                const precio = i.producto.precio_venta || i.producto.costo_promedio_ponderado;
                return (
                  <tr key={i.producto.id_producto}>
                    <td>
                      {i.producto.nombre}<br />
                      <span>T:{i.producto.talla} C:{i.producto.color} x{i.cantidad}</span>
                    </td>
                    <td className="t-right">{moneda(i.cantidad * precio)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="t-sep" />
          <table>
            <tbody>
              <tr><td className="t-bold t-lg">TOTAL</td><td className="t-right t-bold t-lg">{moneda(ticket.total)}</td></tr>
            </tbody>
          </table>
          <div className="t-sep" />
          <p>Cliente: {ticket.cliente?.nombre ?? 'PÚBLICO GENERAL'}</p>
          {ticket.cliente?.documento && <p>Doc: {ticket.cliente.documento}</p>}
          <div className="t-sep" />
          <p className="t-center">¡Gracias por su compra!</p>
          <p className="t-center">Cambios con ticket · 7 días</p>
          <div className="t-cut" />
        </div>
      )}
    </div>
  );
}
