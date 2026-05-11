import React, { useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────
const GREEN     = '#006400';
const GOLD      = '#FFD700';
const STORE_KEY = '@shumi_offerings_v1'; // Single AsyncStorage key — one read/write

const OFFERING_TYPES = ['Sabbath School', 'Divine'];

const DENOMINATIONS = [
  { id: 'R200', label: 'R200', value: 200.00, isNote: true  },
  { id: 'R100', label: 'R100', value: 100.00, isNote: true  },
  { id: 'R50',  label: 'R50',  value: 50.00,  isNote: true  },
  { id: 'R20',  label: 'R20',  value: 20.00,  isNote: true  },
  { id: 'R10',  label: 'R10',  value: 10.00,  isNote: true  },
  { id: 'R5',   label: 'R5',   value: 5.00,   isNote: false },
  { id: 'R2',   label: 'R2',   value: 2.00,   isNote: false },
  { id: 'R1',   label: 'R1',   value: 1.00,   isNote: false },
  { id: 'c20',  label: '20c',  value: 0.20,   isNote: false },
  { id: 'c10',  label: '10c',  value: 0.10,   isNote: false },
];

// ─── ADT: OfferingRecord ──────────────────────────────────────────────────────
//
// Compact on-disk shape (abbreviated keys = fewer bytes per record):
//
//   {
//     id : string,          — base-36 timestamp (e.g. "lf3k2")
//     d  : string,          — date  "DD/MM/YYYY"
//     ss : OfferingData,    — Sabbath School
//     dv : OfferingData,    — Divine
//     ot : number,          — overall total
//   }
//
//   OfferingData = { c, sn, sc, t, lc, cf }
//     c  : object   — non-zero counts only  { R200: 2, R50: 1, … }
//     sn : number   — subtotal notes
//     sc : number   — subtotal coins
//     t  : number   — total
//     lc : number   — local church share (50 %)
//     cf : number   — conference share   (50 %)

/**
 * Strip zero or empty values so only meaningful counts occupy storage.
 * @param {Object} counts  — { denomId: "qty", … }
 * @returns {Object}       — { denomId: qty, … }  (numbers, non-zero only)
 */
function compactCounts(counts) {
  const out = {};
  Object.entries(counts).forEach(([k, v]) => {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) out[k] = n;
  });
  return out;
}

/**
 * Expand compact counts back to string-keyed format expected by the calculator.
 * @param {Object} compact  — { denomId: qty, … }
 * @returns {Object}        — { denomId: "qty", … }
 */
function expandCounts(compact) {
  const out = {};
  Object.entries(compact || {}).forEach(([k, v]) => { out[k] = String(v); });
  return out;
}

/**
 * Factory — construct a new OfferingRecord ADT.
 *
 * @param {string} date
 * @param {Object} ssResult   — { subNotes, subCoins, total, localChurch, conference }
 * @param {Object} dvResult   — same shape
 * @param {number} overallTotal
 * @param {Object} ssCounts   — raw calculator counts for Sabbath School
 * @param {Object} dvCounts   — raw calculator counts for Divine
 * @returns {Object}  OfferingRecord
 */
function createOfferingRecord(date, ssResult, dvResult, overallTotal, ssCounts, dvCounts) {
  return {
    id: Date.now().toString(36),           // compact, monotonically increasing
    d:  date,
    ss: {
      c:  compactCounts(ssCounts),
      sn: ssResult.subNotes,
      sc: ssResult.subCoins,
      t:  ssResult.total,
      lc: ssResult.localChurch,
      cf: ssResult.conference,
    },
    dv: {
      c:  compactCounts(dvCounts),
      sn: dvResult.subNotes,
      sc: dvResult.subCoins,
      t:  dvResult.total,
      lc: dvResult.localChurch,
      cf: dvResult.conference,
    },
    ot: overallTotal,
  };
}

// ─── Singleton: OfferingStore ─────────────────────────────────────────────────
//
// One instance exists for the lifetime of the app (Singleton pattern).
// All records are held in _records (in-memory list of OfferingRecord ADTs).
// Every mutating operation immediately persists the full list to AsyncStorage
// under a single key — one JSON.stringify / JSON.parse per operation.
//
// Why one key instead of one key-per-record?
//   • Fewer I/O round-trips for list retrieval.
//   • AsyncStorage performs best with fewer, larger writes.
//   • Total data size for typical church usage (< 100 records × ~200 bytes) is
//     well under the 2 MB practical limit, so splitting gains nothing.

class OfferingStore {
  static _instance = null;

  /** Always return the same instance. */
  static getInstance() {
    if (!OfferingStore._instance) {
      OfferingStore._instance = new OfferingStore();
    }
    return OfferingStore._instance;
  }

  constructor() {
    this._records = [];   // List<OfferingRecord>
    this._loaded  = false;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /** Load all records from AsyncStorage into memory. Call once at app start. */
  async load() {
    if (this._loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORE_KEY);
      this._records = raw ? JSON.parse(raw) : [];
    } catch {
      this._records = [];
    }
    this._loaded = true;
  }

  /** Serialise the in-memory list and write to AsyncStorage. */
  async _persist() {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(this._records));
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Returns a shallow copy of all records, newest first. */
  getAll() {
    // id is base-36 timestamp → lexicographic descending ≡ newest first
    return [...this._records].sort((a, b) => (b.id > a.id ? 1 : -1));
  }

  /** Returns a single OfferingRecord by id, or null if not found. */
  getById(id) {
    return this._records.find(r => r.id === id) ?? null;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /** Append a new OfferingRecord and persist. Returns the saved record. */
  async add(record) {
    this._records.push(record);
    await this._persist();
    return record;
  }

  /**
   * Replace an existing record by id and persist.
   * The original id is preserved regardless of what updatedRecord.id says.
   * @returns {boolean} true if found and updated, false otherwise.
   */
  async update(id, updatedRecord) {
    const idx = this._records.findIndex(r => r.id === id);
    if (idx === -1) return false;
    this._records[idx] = { ...updatedRecord, id }; // lock id
    await this._persist();
    return true;
  }

  /**
   * Remove a record by id and persist.
   * @returns {boolean} true if found and removed, false otherwise.
   */
  async remove(id) {
    const before = this._records.length;
    this._records = this._records.filter(r => r.id !== id);
    if (this._records.length !== before) {
      await this._persist();
      return true;
    }
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function todayString() {
  return new Date().toLocaleDateString('en-GB');
}

function calcTotals(counts) {
  let subNotes = 0, subCoins = 0;
  DENOMINATIONS.forEach(({ id, value, isNote }) => {
    const qty = parseInt(counts[id] || '0', 10);
    const amt = isNaN(qty) ? 0 : qty * value;
    if (isNote) subNotes += amt;
    else        subCoins += amt;
  });
  return { subNotes, subCoins, total: subNotes + subCoins };
}

function buildBreakdown(counts, offeringType, date) {
  const lines = [`DATE: ${date}`, `TYPE: ${offeringType}`, '', 'BREAKDOWN:'];
  DENOMINATIONS.forEach(({ id, label, value }) => {
    const qty = parseInt(counts[id] || '0', 10);
    if (!isNaN(qty) && qty > 0) {
      lines.push(`  ${label} × ${qty} = R${(qty * value).toFixed(2)}`);
    }
  });
  return lines.join('\n');
}

// ─── DenomRow ─────────────────────────────────────────────────────────────────
function DenomRow({ denom, value, onChange }) {
  const qty      = parseInt(value || '0', 10);
  const isValid  = !isNaN(qty) && qty >= 0 && Number.isInteger(qty);
  const subtotal = isValid && value !== '' ? (qty * denom.value).toFixed(2) : null;

  return (
    <View style={styles.denomRow}>
      <Text style={styles.denomLabel}>{denom.label}</Text>
      <TextInput
        style={[styles.denomInput, !isValid && value !== '' && styles.denomInputError]}
        value={value}
        onChangeText={onChange}
        keyboardType="numeric"
        placeholder="0"
        placeholderTextColor="#aaa"
        maxLength={5}
      />
      <Text style={styles.denomSub}>{subtotal !== null ? `= R${subtotal}` : ''}</Text>
    </View>
  );
}

// ─── RecordDetailView ─────────────────────────────────────────────────────────
function RecordDetailView({ record, onBack, onEdit, onDelete }) {
  const sections = [
    { key: 'ss', label: 'Sabbath School', data: record.ss },
    { key: 'dv', label: 'Divine',         data: record.dv },
  ];

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>{record.d}</Text>

        {sections.map(({ key, label, data }) => {
          const breakdown = buildBreakdown(expandCounts(data.c), label, record.d);
          return (
            <View key={key} style={styles.offeringResult}>
              <Text style={styles.offeringTitle}>{label}</Text>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Subtotal Notes</Text>
                <Text style={styles.resultValue}>R{data.sn.toFixed(2)}</Text>
              </View>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Subtotal Coins</Text>
                <Text style={styles.resultValue}>R{data.sc.toFixed(2)}</Text>
              </View>
              <View style={[styles.resultRow, styles.resultTotalRow]}>
                <Text style={[styles.resultLabel, styles.resultTotalLabel]}>TOTAL</Text>
                <Text style={[styles.resultValue, styles.resultTotalValue]}>R{data.t.toFixed(2)}</Text>
              </View>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Local Church (50%)</Text>
                <Text style={styles.resultValue}>R{data.lc.toFixed(2)}</Text>
              </View>
              <View style={styles.resultRow}>
                <Text style={styles.resultLabel}>Conference (50%)</Text>
                <Text style={styles.resultValue}>R{data.cf.toFixed(2)}</Text>
              </View>
              <Text style={styles.breakdownHeading}>Breakdown</Text>
              <Text style={styles.breakdownText}>{breakdown}</Text>
            </View>
          );
        })}

        <View style={[styles.resultRow, styles.resultTotalRow]}>
          <Text style={[styles.resultLabel, styles.resultTotalLabel]}>OVERALL TOTAL</Text>
          <Text style={[styles.resultValue, styles.resultTotalValue]}>R{record.ot.toFixed(2)}</Text>
        </View>
      </View>

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.editActionBtn} onPress={onEdit} activeOpacity={0.8}>
          <Text style={styles.editActionBtnText}>✏️  EDIT</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.deleteActionBtn} onPress={onDelete} activeOpacity={0.8}>
          <Text style={styles.deleteActionBtnText}>🗑  DELETE</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.8}>
        <Text style={styles.backBtnText}>← Back to Records</Text>
      </TouchableOpacity>

      <View style={styles.footer}>
        <Text style={styles.footerText}>by Br. L. Brukwe (060 416 3808)</Text>
      </View>
    </ScrollView>
  );
}

// ─── RecordsListView ──────────────────────────────────────────────────────────
function RecordsListView({ records, onSelect, onBack }) {
  if (records.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>📋</Text>
        <Text style={styles.emptyText}>No saved records yet.</Text>
        <Text style={styles.emptySubText}>Calculate and save an offering to see it here.</Text>
        <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.8}>
          <Text style={styles.backBtnText}>← Back to Calculator</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Saved Records ({records.length})</Text>
        {records.map((record, idx) => (
          <TouchableOpacity
            key={record.id}
            style={[styles.recordItem, idx === records.length - 1 && { borderBottomWidth: 0 }]}
            onPress={() => onSelect(record)}
            activeOpacity={0.7}
          >
            <View>
              <Text style={styles.recordDate}>{record.d}</Text>
              <Text style={styles.recordSub}>
                SS: R{record.ss.t.toFixed(2)}  |  Divine: R{record.dv.t.toFixed(2)}
              </Text>
            </View>
            <Text style={styles.recordTotal}>R{record.ot.toFixed(2)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.8}>
        <Text style={styles.backBtnText}>← Back to Calculator</Text>
      </TouchableOpacity>

      <View style={styles.footer}>
        <Text style={styles.footerText}>by Br. L. Brukwe (060 416 3808)</Text>
      </View>
    </ScrollView>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const store = OfferingStore.getInstance();
  const today = todayString();

  // screen: 'calculator' | 'records' | 'detail'
  const [screen,     setScreen]     = useState('calculator');
  const [counts,     setCounts]     = useState({ 'Sabbath School': {}, 'Divine': {} });
  const [result,     setResult]     = useState(null);
  const [records,    setRecords]    = useState([]);
  const [selected,   setSelected]   = useState(null);  // OfferingRecord being viewed
  const [editMode,   setEditMode]   = useState(false); // true when editing an existing record
  const [storeReady, setStoreReady] = useState(false);

  // Boot: load store from AsyncStorage exactly once
  useEffect(() => {
    store.load().then(() => {
      setRecords(store.getAll());
      setStoreReady(true);
    });
  }, []);

  // ── Calculator ─────────────────────────────────────────────────────────────

  const handleChange = useCallback((offeringType, id, text) => {
    if (text !== '' && !/^\d+$/.test(text)) return;
    setCounts(prev => ({
      ...prev,
      [offeringType]: { ...prev[offeringType], [id]: text },
    }));
  }, []);

  const handleCalculate = () => {
    const results = {};
    let overallTotal = 0;
    OFFERING_TYPES.forEach(offeringType => {
      const { subNotes, subCoins, total } = calcTotals(counts[offeringType] || {});
      const breakdown    = buildBreakdown(counts[offeringType] || {}, offeringType, today);
      const localChurch  = total / 2;
      const conference   = total / 2;
      results[offeringType] = { subNotes, subCoins, total, localChurch, conference, breakdown };
      overallTotal += total;
    });
    setResult({ results, overallTotal });
  };

  const handleReset = () => {
    setCounts({ 'Sabbath School': {}, 'Divine': {} });
    setResult(null);
    if (editMode) { setEditMode(false); setSelected(null); }
  };

  // ── Save / Update ──────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!result) return;
    const ssRes = result.results['Sabbath School'];
    const dvRes = result.results['Divine'];

    // createOfferingRecord uses the stored date when editing so date is preserved
    const record = createOfferingRecord(
      editMode && selected ? selected.d : today,
      ssRes, dvRes, result.overallTotal,
      counts['Sabbath School'],
      counts['Divine'],
    );

    if (editMode && selected) {
      await store.update(selected.id, record);
      Alert.alert('Updated', `Record for ${selected.d} has been updated.`);
    } else {
      await store.add(record);
      Alert.alert('Saved', `Record for ${today} has been saved.`);
    }

    setRecords(store.getAll());
    handleReset();
  };

  // ── Record navigation ──────────────────────────────────────────────────────

  const handleViewRecords = () => {
    setRecords(store.getAll());
    setScreen('records');
  };

  const handleSelectRecord = (record) => {
    setSelected(record);
    setScreen('detail');
  };

  // Pre-populate the calculator with the selected record's denomination counts
  const handleEditRecord = () => {
    setCounts({
      'Sabbath School': expandCounts(selected.ss.c),
      'Divine':         expandCounts(selected.dv.c),
    });
    setResult(null);
    setEditMode(true);
    setScreen('calculator');
  };

  const handleDeleteRecord = () => {
    Alert.alert(
      'Delete Record',
      `Delete the offering record for ${selected.d}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            await store.remove(selected.id);
            setRecords(store.getAll());
            setSelected(null);
            setScreen('records');
          },
        },
      ],
    );
  };

  // ── Loading gate ───────────────────────────────────────────────────────────
  if (!storeReady) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loadingView}>
          <Text style={styles.logo}>SHUMI</Text>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>

      {/* ── Persistent header ── */}
      <View style={styles.header}>
        <Text style={styles.logo}>SHUMI</Text>
        <View style={styles.headerRight}>
          <Text style={styles.date}>{today}</Text>
          <TouchableOpacity
            style={styles.historyBtn}
            onPress={handleViewRecords}
            activeOpacity={0.8}
          >
            <Text style={styles.historyBtnText}>📋 {records.length}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Records list ── */}
      {screen === 'records' && (
        <RecordsListView
          records={records}
          onSelect={handleSelectRecord}
          onBack={() => setScreen('calculator')}
        />
      )}

      {/* ── Record detail ── */}
      {screen === 'detail' && selected && (
        <RecordDetailView
          record={selected}
          onBack={() => setScreen('records')}
          onEdit={handleEditRecord}
          onDelete={handleDeleteRecord}
        />
      )}

      {/* ── Calculator ── */}
      {screen === 'calculator' && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
          >
            {/* Edit mode banner */}
            {editMode && selected && (
              <View style={styles.editBanner}>
                <Text style={styles.editBannerText}>✏️  Editing: {selected.d}</Text>
                <TouchableOpacity onPress={handleReset}>
                  <Text style={styles.editBannerCancel}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Sabbath School ── */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Sabbath School Offering</Text>
              <Text style={styles.subSectionTitle}>Notes</Text>
              {DENOMINATIONS.filter(d => d.isNote).map(denom => (
                <DenomRow key={`ss-${denom.id}`} denom={denom}
                  value={counts['Sabbath School'][denom.id] || ''}
                  onChange={text => handleChange('Sabbath School', denom.id, text)} />
              ))}
              <Text style={styles.subSectionTitle}>Coins</Text>
              {DENOMINATIONS.filter(d => !d.isNote).map(denom => (
                <DenomRow key={`ss-${denom.id}`} denom={denom}
                  value={counts['Sabbath School'][denom.id] || ''}
                  onChange={text => handleChange('Sabbath School', denom.id, text)} />
              ))}
            </View>

            {/* ── Divine ── */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Divine Offering</Text>
              <Text style={styles.subSectionTitle}>Notes</Text>
              {DENOMINATIONS.filter(d => d.isNote).map(denom => (
                <DenomRow key={`div-${denom.id}`} denom={denom}
                  value={counts['Divine'][denom.id] || ''}
                  onChange={text => handleChange('Divine', denom.id, text)} />
              ))}
              <Text style={styles.subSectionTitle}>Coins</Text>
              {DENOMINATIONS.filter(d => !d.isNote).map(denom => (
                <DenomRow key={`div-${denom.id}`} denom={denom}
                  value={counts['Divine'][denom.id] || ''}
                  onChange={text => handleChange('Divine', denom.id, text)} />
              ))}
            </View>

            {/* ── Calculate ── */}
            <TouchableOpacity style={styles.calcBtn} onPress={handleCalculate} activeOpacity={0.8}>
              <Text style={styles.calcBtnText}>CALCULATE</Text>
            </TouchableOpacity>

            {/* ── Results ── */}
            {result && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Results</Text>

                {OFFERING_TYPES.map(offeringType => {
                  const res = result.results[offeringType];
                  return (
                    <View key={offeringType} style={styles.offeringResult}>
                      <Text style={styles.offeringTitle}>{offeringType}</Text>
                      <View style={styles.resultRow}>
                        <Text style={styles.resultLabel}>Subtotal Notes</Text>
                        <Text style={styles.resultValue}>R{res.subNotes.toFixed(2)}</Text>
                      </View>
                      <View style={styles.resultRow}>
                        <Text style={styles.resultLabel}>Subtotal Coins</Text>
                        <Text style={styles.resultValue}>R{res.subCoins.toFixed(2)}</Text>
                      </View>
                      <View style={[styles.resultRow, styles.resultTotalRow]}>
                        <Text style={[styles.resultLabel, styles.resultTotalLabel]}>TOTAL</Text>
                        <Text style={[styles.resultValue, styles.resultTotalValue]}>R{res.total.toFixed(2)}</Text>
                      </View>
                      <View style={styles.resultRow}>
                        <Text style={styles.resultLabel}>Local Church (50%)</Text>
                        <Text style={styles.resultValue}>R{res.localChurch.toFixed(2)}</Text>
                      </View>
                      <View style={styles.resultRow}>
                        <Text style={styles.resultLabel}>Conference (50%)</Text>
                        <Text style={styles.resultValue}>R{res.conference.toFixed(2)}</Text>
                      </View>
                      <Text style={styles.breakdownHeading}>Breakdown</Text>
                      <Text style={styles.breakdownText}>{res.breakdown}</Text>
                    </View>
                  );
                })}

                <View style={[styles.resultRow, styles.resultTotalRow]}>
                  <Text style={[styles.resultLabel, styles.resultTotalLabel]}>OVERALL TOTAL</Text>
                  <Text style={[styles.resultValue, styles.resultTotalValue]}>R{result.overallTotal.toFixed(2)}</Text>
                </View>

                {/* Save + Reset */}
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.8}>
                    <Text style={styles.saveBtnText}>{editMode ? '💾  UPDATE' : '💾  SAVE'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.resetBtn} onPress={handleReset} activeOpacity={0.8}>
                    <Text style={styles.resetBtnText}>RESET</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* ── Footer ── */}
            <View style={styles.footer}>
              <Text style={styles.footerText}>by Br. L. Brukwe (060 416 3808)</Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f4f4f4',
  },
  scroll: {
    paddingBottom: 40,
  },

  /* Loading */
  loadingView: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: GREEN,
  },
  loadingText: {
    color: GOLD,
    fontSize: 16,
    marginTop: 8,
    fontWeight: '600',
  },

  /* Header */
  header: {
    backgroundColor: GREEN,
    borderRadius: 16,
    margin: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: {
    color: GOLD,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 4,
  },
  headerRight: {
    alignItems: 'flex-end',
    gap: 6,
  },
  date: {
    color: GOLD,
    fontSize: 16,
    fontWeight: '600',
  },
  historyBtn: {
    backgroundColor: 'rgba(255,215,0,0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: GOLD,
  },
  historyBtnText: {
    color: GOLD,
    fontWeight: '700',
    fontSize: 13,
  },

  /* Edit banner */
  editBanner: {
    backgroundColor: '#fff3cd',
    borderLeftWidth: 4,
    borderLeftColor: '#ffa500',
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  editBannerText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#7a4a00',
  },
  editBannerCancel: {
    fontSize: 13,
    color: '#c0392b',
    fontWeight: '700',
  },

  /* Cards */
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    marginHorizontal: 12,
    marginTop: 10,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 6,
    elevation: 3,
  },
  sectionTitle: {
    color: GREEN,
    fontSize: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  subSectionTitle: {
    color: GREEN,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 6,
  },

  /* Denom rows */
  denomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  denomLabel: {
    width: 44,
    fontWeight: '700',
    color: GREEN,
    fontSize: 14,
  },
  denomInput: {
    width: 60,
    borderWidth: 1.5,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === 'ios' ? 6 : 4,
    fontSize: 14,
    color: '#222',
    textAlign: 'center',
    backgroundColor: '#fafafa',
  },
  denomInputError: {
    borderColor: '#e53',
  },
  denomSub: {
    marginLeft: 10,
    fontSize: 13,
    color: '#555',
    flex: 1,
  },

  /* Calculate button */
  calcBtn: {
    backgroundColor: GREEN,
    borderRadius: 14,
    marginHorizontal: 12,
    marginTop: 16,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: GREEN,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  calcBtnText: {
    color: GOLD,
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 2,
  },

  /* Results */
  offeringResult: {
    marginBottom: 20,
  },
  offeringTitle: {
    color: GREEN,
    fontSize: 16,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  resultLabel: {
    fontSize: 14,
    color: '#555',
  },
  resultValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
  },
  resultTotalRow: {
    marginTop: 4,
    borderBottomWidth: 0,
    backgroundColor: '#f9f5e0',
    borderRadius: 8,
    paddingHorizontal: 8,
  },
  resultTotalLabel: {
    color: GREEN,
    fontWeight: '800',
    fontSize: 16,
  },
  resultTotalValue: {
    color: GREEN,
    fontWeight: '900',
    fontSize: 20,
  },
  breakdownHeading: {
    marginTop: 16,
    marginBottom: 6,
    color: GREEN,
    fontWeight: '700',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  breakdownText: {
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    fontSize: 12,
    color: '#333',
    lineHeight: 20,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    padding: 10,
  },

  /* Action row (Save + Reset) */
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
  },
  saveBtn: {
    flex: 1,
    backgroundColor: GREEN,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  saveBtnText: {
    color: GOLD,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },
  resetBtn: {
    flex: 1,
    borderWidth: 2,
    borderColor: GREEN,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  resetBtnText: {
    color: GREEN,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },

  /* Records list */
  recordItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  recordDate: {
    fontSize: 15,
    fontWeight: '700',
    color: GREEN,
  },
  recordSub: {
    fontSize: 12,
    color: '#777',
    marginTop: 2,
  },
  recordTotal: {
    fontSize: 16,
    fontWeight: '900',
    color: GREEN,
  },

  /* Detail screen action buttons */
  editActionBtn: {
    flex: 1,
    backgroundColor: GREEN,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  editActionBtnText: {
    color: GOLD,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },
  deleteActionBtn: {
    flex: 1,
    borderWidth: 2,
    borderColor: '#c0392b',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  deleteActionBtnText: {
    color: '#c0392b',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 1,
  },

  /* Back button */
  backBtn: {
    marginHorizontal: 12,
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  backBtnText: {
    color: GREEN,
    fontWeight: '700',
    fontSize: 14,
  },

  /* Empty state */
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '800',
    color: GREEN,
    marginBottom: 6,
  },
  emptySubText: {
    fontSize: 13,
    color: '#888',
    textAlign: 'center',
    marginBottom: 24,
  },

  /* Footer */
  footer: {
    marginTop: 24,
    alignItems: 'center',
  },
  footerText: {
    color: '#999',
    fontSize: 12,
  },
});
