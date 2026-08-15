import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Box, CircularProgress, IconButton, Tooltip } from "@mui/material";
import { KeyboardArrowDownRounded } from "@mui/icons-material";

// Região mínima considerada "fim da lista": só autoscrolla quando o scroll já
// estiver colado no final. Se o usuário subir ~0.5cm, para.
const NEAR_BOTTOM_PX = 32;
// Espaço vertical uniforme entre itens da corrente (no modo coluna única ele
// substitui o margin-bottom das mensagens; os margins são zerados via CSS).
const ITEM_GAP_PX = 16;
// Altura estimada de um item ainda não medido — usada por um único frame, até
// o medidor oculto devolver a altura real.
const ESTIMATED_ITEM_HEIGHT = 110;

export type ColumnLayout = {
  width: number;
  columns: number;
  gap: number;
  padX: number;
  columnWidth: number;
  contentWidth: number;
};

/**
 * Mede a largura do contêiner e deriva o layout de colunas contínuas
 * (modelo "fluxo contínuo": uma única corrente de mensagens cortada em
 * fatias verticais — a emenda entre colunas é perfeita):
 *  - < 1000px  → 1 coluna  (comportamento atual)
 *  - >= 1000px → 2 colunas
 *  - >= 1600px → 3 colunas
 *  - >= 2300px → 4 colunas
 *
 * Retorna um ref de callback (reatribuído a cada montagem do elemento) e o
 * layout derivado da largura observada.
 */
/** Mede a altura de um elemento (callback ref + ResizeObserver). */
export function useMeasuredHeight<T extends HTMLElement>(): { ref: (el: T | null) => void; height: number } {
  const [height, setHeight] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setHeight(0);
      return;
    }
    const update = () => setHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  return { ref, height };
}

export function useColumnLayout<T extends HTMLElement>(): {
  ref: (el: T | null) => void;
  layout: ColumnLayout;
} {
  const [width, setWidth] = useState(0);
  const roRef = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((el: T | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!el) {
      setWidth(0);
      return;
    }
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);
  const columns = width >= 2300 ? 4 : width >= 1600 ? 3 : width >= 1000 ? 2 : 1;
  const gap = ITEM_GAP_PX;
  const padX = 16;
  const columnWidth = Math.max(1, (width - (columns - 1) * gap - 2 * padX) / columns);
  return {
    ref: setRef,
    layout: { width, columns, gap, padX, columnWidth, contentWidth: Math.max(1, columnWidth - 2 * padX) },
  };
}

export type StreamItem = { key: string; node: ReactNode };

export type MultiColumnStreamHandle = {
  /** Gruda a rolagem no fim da corrente (usado ao enviar mensagem). */
  stickToEnd: () => void;
};

type MultiColumnStreamProps = {
  /** Itens da corrente (já renderizados, com chave estável). */
  items: StreamItem[];
  /** Item extra no fim da corrente (ex.: bolha de streaming em andamento). */
  tail?: ReactNode;
  loading: boolean;
  /** Conteúdo exibido quando não há itens e não está carregando. */
  empty?: ReactNode;
  layout: ColumnLayout;
  className?: string;
  /** Quando muda, força a rolagem ao fim (ex.: nova mensagem de grupo). */
  forceStickSignal?: number;
  /** Altura da caixa de texto sobreposta (a 1ª coluna termina acima dela). */
  composerHeight?: number;
};

/**
 * Lista de mensagens em colunas contínuas (modelo A):
 *  - uma única "corrente" de conteúdo com altura total V;
 *  - a área visível é uma janela de altura H cortada em N colunas lado a lado;
 *    a coluna k mostra a fatia [S + k·H, S + (k+1)·H) da corrente, com S = scroll;
 *  - scroll único sincronizado: rolar move todas as colunas juntas;
 *  - a emenda entre colunas é perfeita (item que atravessa a emenda é
 *    renderizado nas duas colunas, com a parte correta em cada uma);
 *  - alturas reais são medidas num contêiner oculto com a largura da coluna
 *    (itens novos/mudados apenas — sem medir tudo a cada frame).
 */
export const MultiColumnStream = forwardRef<MultiColumnStreamHandle, MultiColumnStreamProps>(
  function MultiColumnStream({ items, tail, loading, empty, layout, className, forceStickSignal, composerHeight = 0 }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const measureRef = useRef<HTMLDivElement | null>(null);
    const [height, setHeight] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
    const heightsRef = useRef(new Map<string, number>());
    const prevNodesRef = useRef<Map<string, ReactNode>>(new Map());
    const prevLayoutRef = useRef<ColumnLayout | null>(null);
    const stickRef = useRef(true);
    const scrollTopRef = useRef(0);
    const [showJump, setShowJump] = useState(false);
    const rafRef = useRef(0);

    const combined = useMemo<StreamItem[]>(
      () => (tail ? [...items, { key: "live-stream", node: tail }] : items),
      [items, tail],
    );

    // Observa a altura útil do contêiner de rolagem (H) — define a janela.
    // Callback ref: re-observe a cada montagem do elemento (o stream pode
    // alternar entre spinner/vazio/scroll conforme as mensagens chegam).
    const heightRoRef = useRef<ResizeObserver | null>(null);
    const setScrollRef = useCallback((el: HTMLDivElement | null) => {
      scrollRef.current = el;
      if (heightRoRef.current) {
        heightRoRef.current.disconnect();
        heightRoRef.current = null;
      }
      if (!el) {
        setHeight(0);
        return;
      }
      const update = () => setHeight(el.clientHeight);
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      heightRoRef.current = ro;
    }, []);
    useEffect(() => () => heightRoRef.current?.disconnect(), []);

    // ---- Passo de medição: itens novos/mudados são medidos no contêiner
    // oculto (mesma largura de coluna). Mudança de largura invalida o cache
    // inteiro (todo texto re-quebra). ----
    useLayoutEffect(() => {
      const root = measureRef.current;
      if (!root || layout.width <= 0) return;
      const prevLayout = prevLayoutRef.current;
      prevLayoutRef.current = layout;
      const layoutChanged =
        !prevLayout || prevLayout.contentWidth !== layout.contentWidth || prevLayout.columns !== layout.columns;
      if (layoutChanged) heightsRef.current.clear();
      const prevNodes = prevNodesRef.current;
      const dirty = new Set<string>();
      if (layoutChanged) {
        for (const item of combined) dirty.add(item.key);
      } else {
        for (const item of combined) if (prevNodes.get(item.key) !== item.node) dirty.add(item.key);
      }
      prevNodesRef.current = new Map(combined.map((item) => [item.key, item.node]));
      if (!dirty.size) return;
      let changed = false;
      for (const key of dirty) {
        const el = root.querySelector<HTMLElement>(`[data-stream-key="${CSS.escape(key)}"]`);
        if (!el) continue;
        const measured = el.getBoundingClientRect().height;
        if (measured > 0 && Math.abs(measured - (heightsRef.current.get(key) ?? -1)) > 0.5) {
          heightsRef.current.set(key, measured);
          changed = true;
        }
      }
      if (changed) setHeights(new Map(heightsRef.current));
    }, [combined, layout]);

    // ---- <details> aberto/fechado muda a altura do item: sincroniza o estado
    // entre as cópias (colunas vizinhas + medidor) e re-mede a cópia visível. ----
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const onToggle = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLDetailsElement)) return;
        const wrapper = target.closest<HTMLElement>("[data-stream-key]");
        if (!wrapper) return;
        const key = wrapper.getAttribute("data-stream-key");
        if (!key) return;
        const index = [...wrapper.querySelectorAll("details")].indexOf(target);
        const copies = rootRef.current?.querySelectorAll<HTMLElement>(
          `[data-stream-key="${CSS.escape(key)}"]`,
        ) ?? [];
        if (index >= 0) {
          copies.forEach((copy) => {
            if (copy === wrapper) return;
            const details = copy.querySelectorAll("details")[index];
            if (details) details.open = target.open;
          });
        }
        const measured = wrapper.getBoundingClientRect().height;
        if (measured > 0 && Math.abs(measured - (heightsRef.current.get(key) ?? -1)) > 0.5) {
          heightsRef.current.set(key, measured);
          setHeights(new Map(heightsRef.current));
        }
      };
      el.addEventListener("toggle", onToggle, true);
      return () => el.removeEventListener("toggle", onToggle, true);
    }, []);

    // ---- Rolagem: sincroniza o estado com o scroll real (rAF) e mantém a
    // política "grudar no fundo" (rolar para cima desliga; voltar ao fim liga). ----
    const handleScroll = useCallback(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const max = el.scrollHeight - el.clientHeight;
        const s = Math.min(Math.max(0, el.scrollTop), Math.max(0, max));
        scrollTopRef.current = s;
        setScrollTop(s);
        const atBottom = max - s < NEAR_BOTTOM_PX;
        stickRef.current = atBottom;
        setShowJump(!atBottom && max > 0);
      });
    }, []);
    useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

    // ---- Gruda no fim quando o conteúdo muda (e o usuário estava no fim). ----
    const prevStickSignalRef = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
      const signal = forceStickSignal;
      const signalChanged = signal !== undefined && signal !== prevStickSignalRef.current;
      prevStickSignalRef.current = signal;
      if (loading) return;
      const el = scrollRef.current;
      if (!el) return;
      if (stickRef.current || signalChanged) el.scrollTop = el.scrollHeight;
      const next = Math.min(Math.max(0, el.scrollTop), Math.max(0, el.scrollHeight - el.clientHeight));
      if (next !== scrollTopRef.current) {
        scrollTopRef.current = next;
        setScrollTop(next);
      }
    }, [combined, heights, loading, forceStickSignal]);

    useImperativeHandle(
      ref,
      () => ({
        stickToEnd: () => {
          const el = scrollRef.current;
          if (!el) return;
          stickRef.current = true;
          el.scrollTop = el.scrollHeight;
          scrollTopRef.current = el.scrollTop;
          setScrollTop(el.scrollTop);
          setShowJump(false);
        },
      }),
      [],
    );

    const { columns, columnWidth, gap, padX } = layout;
    // Posições absolutas na corrente (topo acumulado com as alturas medidas).
    const entries = useMemo(() => {
      const list: Array<{ key: string; node: ReactNode; top: number; h: number }> = [];
      let y = 0;
      for (const item of combined) {
        const h = heights.get(item.key) ?? ESTIMATED_ITEM_HEIGHT;
        list.push({ key: item.key, node: item.node, top: y, h });
        y += h + gap;
      }
      return list;
    }, [combined, heights, gap]);
    const total = entries.length ? entries[entries.length - 1].top + entries[entries.length - 1].h + gap : 0;
    const H = height || 1;
    const maxScroll = Math.max(0, total - H);
    const S = Math.min(Math.max(0, scrollTop), maxScroll);

    return (
      <Box
        ref={rootRef}
        className={className}
        sx={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {loading && combined.length === 0 ? (
          <Box className="loading-chat">
            <CircularProgress size={28} />
          </Box>
        ) : !loading && combined.length === 0 && empty ? (
          <Box className="stream-empty">{empty}</Box>
        ) : (
          <Box className="stream-scroll" ref={setScrollRef} onScroll={handleScroll}>
            <Box className="stream-content" style={{ height: total }}>
              {layout.width > 0 && height > 0 && (
                <Box className="stream-viewport" style={{ height: H, paddingInline: padX }}>
                  {(() => {
                    // Alturas por coluna: a 1ª termina acima da caixa de texto
                    // (col0H = H − composerHeight); as demais vão até a base (H).
                    const col0H = Math.max(H - composerHeight, 64);
                    const sliceStartFor = (k: number) => (k === 0 ? S : S + col0H + (k - 1) * H);
                    const colHFor = (k: number) => (k === 0 ? col0H : H);
                    // Colunas com conteúdo na fatia atual; se nenhuma tiver,
                    // mantém ao menos a primeira (ex.: fim da conversa).
                    const withContent = Array.from({ length: columns }, (_, k) => {
                      const sliceStart = sliceStartFor(k);
                      const sliceEnd = sliceStart + colHFor(k);
                      const visible = entries.filter((e) => e.top + e.h > sliceStart && e.top < sliceEnd);
                      return { k, sliceStart, visible };
                    }).filter((c) => c.visible.length > 0);
                    const cols = withContent.length > 0 ? withContent : [{ k: 0, sliceStart: S, visible: [] }];
                    return cols.map(({ k, sliceStart, visible }) => (
                      <Box key={k} className="stream-column" style={{ width: columnWidth, height: colHFor(k), paddingInline: padX }}>
                        {visible.map((e) => (
                          <Box
                            key={e.key}
                            className="stream-item"
                            data-stream-key={e.key}
                            style={{ top: e.top - sliceStart }}
                          >
                            {e.node}
                          </Box>
                        ))}
                      </Box>
                    ));
                  })()}
                </Box>
              )}
            </Box>
          </Box>
        )}
        {showJump && (
          <Tooltip title="Ir para o final">
            <IconButton
              aria-label="Ir para o final"
              onClick={() => {
                const el = scrollRef.current;
                if (!el) return;
                stickRef.current = true;
                el.scrollTop = el.scrollHeight;
                scrollTopRef.current = el.scrollTop;
                setScrollTop(el.scrollTop);
                setShowJump(false);
              }}
              sx={{ position: "absolute", right: 12, bottom: 12, zIndex: 2, bgcolor: "background.paper", boxShadow: 2, "&:hover": { bgcolor: "action.hover" } }}
            >
              <KeyboardArrowDownRounded />
            </IconButton>
          </Tooltip>
        )}
        {/* Medidor oculto: mesma largura de coluna; nunca contribui com o scroll. */}
        {combined.length > 0 && layout.width > 0 && (
          <Box className="stream-measurer" style={{ width: layout.contentWidth }} ref={measureRef}>
            {combined.map((item) => (
              <Box key={item.key} data-stream-key={item.key}>
                {item.node}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  },
);
