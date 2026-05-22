import { useState, useEffect, useRef } from 'react';

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  return options
    .map((o) => {
      if (o == null) return null;
      if (typeof o === 'string') return { value: o, label: o };
      if (typeof o === 'object') {
        if ('value' in o) return { value: String(o.value), label: String(o.label ?? o.value) };
        if ('id' in o) return { value: String(o.id), label: String(o.label ?? o.id) };
        if ('label' in o) return { value: String(o.label), label: String(o.label) };
      }
      return null;
    })
    .filter(Boolean)
    .filter((o) => {
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
}

let _uid = 0;

/**
 * Controlled multi-select dropdown with tag/chip display.
 *
 * Props
 * ─────
 * options       – array of strings or { value, label } objects
 * value         – array of selected values (controlled)
 * onChange      – (newValues: string[]) => void
 * placeholder   – shown when nothing is selected
 * searchable    – show search input inside dropdown (default true)
 * selectAll     – show "Select All" option (default true)
 * id            – HTML id prefix for ARIA wiring
 * ariaLabel     – aria-label for the combobox
 * rootClassName – CSS class on the root div (default "multi-select-compliance")
 * wrapTags      – true = tags wrap vertically; false (default) = single row, hidden scroll
 */
export default function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = 'Select…',
  searchable = true,
  selectAll = true,
  id,
  ariaLabel,
  rootClassName = 'multi-select-compliance',
  wrapTags = false,
  closeOnSelect = false,
}) {
  const uidRef = useRef(id || `ms-${++_uid}`);
  const opts = normalizeOptions(options);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlighted, setHighlighted] = useState(-1);

  const containerRef = useRef(null);
  const searchRef = useRef(null);

  function closeDropdown() {
    setOpen(false);
    setSearch('');
    setHighlighted(-1);
  }

  // Derive selected in original options order
  const incoming = Array.isArray(value) ? value : [];
  const selectedSet = new Set(incoming);
  const selected = [
    ...opts.filter((o) => selectedSet.has(o.value)).map((o) => o.value),
    ...incoming.filter((v) => !opts.some((o) => o.value === v)),
  ];

  const listboxId = `${uidRef.current}-lb`;

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        closeDropdown();
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (open && searchRef.current) {
      const t = setTimeout(() => {
        try { searchRef.current?.focus(); } catch (_) {}
      }, 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Reset highlight when search changes
  useEffect(() => { setHighlighted(-1); }, [search]);

  const hasSearch = search.trim().length > 0;
  const showSelectAll = selectAll && opts.length > 0 && !hasSearch;
  const filtered = hasSearch
    ? opts.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
    : opts;
  const allSelected = opts.length > 0 && opts.every((o) => selectedSet.has(o.value));

  function emit(next) {
    if (typeof onChange === 'function') onChange(next);
  }

  function toggleAll() {
    emit(allSelected ? [] : opts.map((o) => o.value));
  }

  function toggleValue(val) {
    const cur = new Set(incoming);
    if (cur.has(val)) cur.delete(val); else cur.add(val);
    emit(opts.filter((o) => cur.has(o.value)).map((o) => o.value));
    if (closeOnSelect) {
      closeDropdown();
    }
  }

  function removeTag(val) {
    const cur = new Set(incoming);
    cur.delete(val);
    emit(opts.filter((o) => cur.has(o.value)).map((o) => o.value));
  }

  function handleTriggerClick(e) {
    // Don't toggle when the × button on a tag is clicked
    if (e.target.closest && e.target.closest('.ms-tag-remove')) return;
    setOpen((v) => !v);
  }

  function handleTriggerKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
    else if (e.key === 'Escape') { closeDropdown(); }
    else if (e.key === 'Tab') { closeDropdown(); }
  }

  function handleSearchKeyDown(e) {
    const allCount = showSelectAll ? 1 : 0;
    const total = filtered.length + allCount;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h < total - 1 ? h + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h > 0 ? h - 1 : total - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted < 0) return;
      if (showSelectAll && highlighted === 0) { toggleAll(); return; }
      const opt = filtered[highlighted - allCount];
      if (opt) toggleValue(opt.value);
    } else if (e.key === 'Escape') {
      closeDropdown();
    } else if (e.key === 'Tab') {
      closeDropdown();
    } else if (e.key === 'Backspace' && !search && selected.length > 0) {
      removeTag(selected[selected.length - 1]);
    }
  }

  function handleContainerBlur(e) {
    const nextFocused = e.relatedTarget;
    if (containerRef.current && nextFocused && containerRef.current.contains(nextFocused)) return;
    closeDropdown();
  }

  return (
    <div className={rootClassName} ref={containerRef} onBlur={handleContainerBlur}>
      {/* ── Trigger ── */}
      <div
        className={`ms-trigger${open ? ' ms-open' : ''}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={ariaLabel}
        tabIndex={0}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <div className={`ms-tags${wrapTags ? ' ms-tags-wrap' : ''}`}>
          {selected.length === 0 ? (
            <span className="ms-placeholder">{placeholder}</span>
          ) : (
            selected.map((v) => {
              const meta = opts.find((o) => o.value === v) || { value: v, label: v };
              return (
                <span key={v} className="ms-tag" title={meta.label}>
                  <span className="ms-tag-label">{meta.label}</span>
                  <button
                    type="button"
                    className="ms-tag-remove"
                    aria-label={`Remove ${meta.label}`}
                    tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); removeTag(v); }}
                  >
                    ×
                  </button>
                </span>
              );
            })
          )}
        </div>
        <span className="ms-chevron" aria-hidden="true" />
      </div>

      {/* ── Dropdown (conditionally rendered – zero DOM footprint when closed) ── */}
      {open && (
        <div
          className="ms-dropdown"
          role="listbox"
          id={listboxId}
          aria-label={ariaLabel}
          aria-multiselectable="true"
        >
          {searchable && (
            <div className="ms-search-wrap">
              <input
                ref={searchRef}
                type="text"
                className="ms-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search…"
                aria-label="Search options"
                aria-autocomplete="list"
              />
            </div>
          )}

          {showSelectAll && (
            <div
              className={`ms-option${allSelected ? ' ms-selected' : ''}${highlighted === 0 ? ' ms-highlighted' : ''}`}
              role="option"
              aria-selected={allSelected}
              onMouseDown={(e) => { e.preventDefault(); toggleAll(); }}
              onMouseEnter={() => setHighlighted(0)}
            >
              <span className="ms-check">{allSelected ? '✓' : ''}</span>
              <span className="ms-option-label">Select All</span>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="ms-empty">No options found</div>
          ) : (
            filtered.map((opt, i) => {
              const idx = i + (showSelectAll ? 1 : 0);
              const sel = selectedSet.has(opt.value);
              return (
                <div
                  key={opt.value}
                  className={`ms-option${sel ? ' ms-selected' : ''}${highlighted === idx ? ' ms-highlighted' : ''}`}
                  role="option"
                  aria-selected={sel}
                  onMouseDown={(e) => { e.preventDefault(); toggleValue(opt.value); }}
                  onMouseEnter={() => setHighlighted(idx)}
                >
                  <span className="ms-check">{sel ? '✓' : ''}</span>
                  <span className="ms-option-label">{opt.label}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
