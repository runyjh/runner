/**
 * 통장 내역 올리기 (#291) — 은행 거래내역(카카오뱅크·우리은행 PDF/엑셀)을 올리면 한 줄씩 자동 분류해 저장.
 *  · 클라이언트(Admin.html)가 파일을 읽어 rows 로 보내고(날짜·시각·입출금·금액·잔액·거래내용·거래구분), 서버가 분류·연결을 붙여 돌려준다 (미리보기)
 *  · 저장하면 stl_bankrows 에 쌓이고(거래 달 단위 · 같은 키는 덮어씀), 사용자가 고른 분류는 stl_bankrules 에 패턴으로 기억
 *  · 연결(side effect, 저장 때 선택): 기사 정산 입금체크(stl_pay) · 쿠팡 입금 확인(stl_fund) · 운영비 지출 기록(stl_expense, 중복 방지 키)
 *  · 계좌번호 전체는 저장하지 않고 끝 4자리만 (통장 구분용)
 */
const BK_CATS = [
  '기사 정산', '쿠팡 입금', '직원 급여', '원천세 납부', '산재·고용 납부', '부가세 납부', '세금 납부', '가불 지급', '가불 회수',
  '사무실 임대료', '관리비·공과금', '운영비', '세무·회계', '차량 리스·할부', '보험료', '협회비', '유류비', '통신', '식대·접대', '소모품', '이자·수수료', '카드 대금',
  '내부 이체', '이자 수익', '대표 인출', '대표 입금', '사업 무관', '미분류'
];
// 분류 → 지출 기록(stl_expense) 분류. 없는 분류는 지출 기록에 넣지 않는다
const BK_EXPENSE_CAT = {
  '사무실 임대료': '사무실', '관리비·공과금': '보험·공과', '운영비': '기타', '세무·회계': '세무·회계', '차량 리스·할부': '차량', '보험료': '보험·공과', '협회비': '보험·공과', '유류비': '유류비', '통신': '통신',
  '식대·접대': '식대·접대', '소모품': '소모품', '이자·수수료': '이자·수수료',
  '원천세 납부': '세금 납부 (손익 제외)', '부가세 납부': '세금 납부 (손익 제외)', '세금 납부': '세금 납부 (손익 제외)', '산재·고용 납부': '산재·고용 납부 (손익 제외)'
};
function bkNorm_(s) { return str_(s).replace(/\s+/g, '').replace(/\d+/g, '#').toLowerCase(); }
function bkKey_(r) { return [r.acct4, r.date, r.time, r.io, r.amt, str_(r.memo).slice(0, 20)].join('|'); }
function bkMonth_(date) { return str_(date).slice(0, 7); }
/** 계좌 구분 글자: 끝이 숫자면 끝 4자리('****-**-***6179' → 6179), 끝이 가려져 있으면('1002-59*-******') 앞 숫자 4자리 */
function bkAcct4_(v) { const s = str_(v); const m = s.match(/(\d{4})\s*$/); if (m) return m[1]; const d = s.replace(/\D/g, ''); return d.slice(0, 4); }
/** 패턴 규칙: 거래내용(숫자는 #) 완전 일치 → 분류 */
function bkRules_() {
  const out = {};
  stlRead_('stl_bankrules').forEach(function (r) { if (r.pattern) out[r.pattern] = { cat: r.cat, refName: r.refName || '' }; });
  return out;
}
/**
 * 자동 분류. ctx = { D(기사), names(기사 이름 → id[]), staff(이름 → row), banks(통장 끝4 → 통장), nets(정산월별 기사 실입금: { id: {month, net, name} }), deposits({month: plan}), rules }
 *  return { cat, ref, refName, status('자동'|'미분류'|'확인'), hint }
 */
function bkClassify_(r, ctx) {
  const memo = str_(r.memo), m0 = memo.replace(/\s+/g, ''), kind = str_(r.kind), isIn = r.io === '입금', amt = Math.abs(stlNum_(r.amt));
  const rule = ctx.rules[bkNorm_(memo)];
  const out = function (cat, ref, refName, status, hint) { return { cat: cat, ref: ref || '', refName: refName || '', status: status || '자동', hint: hint || '' }; };
  // 1) 내부·자동 성격
  if (/세이프박스/.test(m0) || kind === '세이프박스') return out('내부 이체', '', '세이프박스', '자동');
  if (/통장이자|예금결산이자|결산이자/.test(m0) || kind === '예금이자') return out('이자 수익');
  if (/캐시백/.test(m0) || kind === '캐시백') return out('이자 수익', '', '캐시백');
  if (/가불금회수|가불회수/.test(m0)) return out('가불 회수', '', bkName_(m0.replace(/가불금?회수/, '')));
  if (/가불금?/.test(m0)) return out(isIn ? '가불 회수' : '가불 지급', '', bkName_(m0.replace(/가불금?/, '')));
  if (/쿠팡로지스틱|쿠팡풀필먼트|쿠팡\(주\)|CFS/.test(m0) && isIn) { const dm = bkDepositMonth_(r.date, amt, ctx.deposits); return out('쿠팡 입금', dm.month, '쿠팡 ' + (dm.month ? bkYm_(dm.month) + ' 정산' : ''), dm.month ? '자동' : '확인', dm.hint); }
  if (/원천지방세|지방소득세/.test(m0)) return out('원천세 납부', '', '지방소득세');
  if (/원천세/.test(m0)) return out('원천세 납부', '', bkName_(m0.replace(/원천세.*/, '')));
  if (/사회보험|산재|고용보험|근로복지공단|건강보험공단/.test(m0) && !isIn) return out('산재·고용 납부');
  if (/부가세|부가가치세/.test(m0) && !isIn && /고지|납부|신고/.test(m0)) return out('부가세 납부');
  if (/종합소득세|소득세|지방세|국세|세무서/.test(m0) && !isIn && !/세무사|세무회계/.test(m0)) return out('세금 납부');
  if (/추정치|^운영비$|^운영비\d*$|기사정산금이체|유보금|인건비/.test(m0)) return out('내부 이체', '', m0, '자동', '올인원 통장 사이 이체');
  // 2) 규칙(사용자가 전에 고른 것)
  if (rule) return out(rule.cat, '', rule.refName, '자동');
  // 3) 직원 급여
  const stName = Object.keys(ctx.staff).filter(function (n) { return n && m0.indexOf(n) >= 0; })[0];
  if (stName && !isIn) { const s = ctx.staff[stName]; const net = stlR0_(stlNum_(s.pay)) - stlWht_(stlR0_(stlNum_(s.pay)), s.taxRate); return out('직원 급여', '', stName, Math.abs(net - amt) <= 10 ? '자동' : '확인', Math.abs(net - amt) <= 10 ? '' : '직원 탭 실지급 ' + won_(net) + '원과 다름'); }
  // 4) 기사 송금: 이름이 들어 있고 금액이 어느 정산월 실입금과 같으면 연결
  if (!isIn) {
    const nm = bkName_(m0);
    const ids = ctx.names[nm] || [];
    let hit = null;
    ids.forEach(function (id) { (ctx.nets[id] || []).forEach(function (x) { if (Math.abs(x.net - amt) <= 1000 && (!hit || Math.abs(x.net - amt) < Math.abs(hit.net - amt))) hit = x; }); });
    if (hit) return out('기사 정산', hit.month + '|' + hit.id, hit.name + ' ' + bkYm_(hit.month) + ' 정산', '자동', hit.net !== amt ? '실입금 ' + won_(hit.net) + '원 (차이 ' + won_(amt - hit.net) + ')' : '');
    if (ids.length) {
      // 금액이 안 맞는 기사 송금 (분할 이체·추가 지급 등)
      const cand = (ctx.nets[ids[0]] || []).slice(-2).map(function (x) { return bkYm_(x.month) + ' ' + won_(x.net); }).join(' · ');
      return out('기사 정산', '', nm, '확인', '금액이 정산서와 다름' + (cand ? ' (실입금 ' + cand + ')' : ''));
    }
  }
  // 개인 성격이 분명한 것 (대표 이름이 붙어 있어도 먼저)
  if (/노란우산|^노란\d/.test(m0)) return out('사업 무관', '', '노란우산공제', '자동', '소득공제 자료 — 세무사에게 따로 전달');
  if (/아파트관리비|아파트|청약|적금|펀드|주택|정수기|렌탈|넷플릭스|유튜브/.test(m0) && !isIn) return out('사업 무관', '', m0, '확인');
  if (/임대료|월세|임차료|사무실/.test(m0) && !isIn) return out('사무실 임대료', '', m0, '확인', '사무실 임대료면 세금계산서(또는 현금영수증) 증빙 확인');
  if (/관리비|전기요금|한전|한국전력|수도요금|도시가스|가스요금|공과금/.test(m0) && !isIn) return out('관리비·공과금', '', m0, '확인', '사무실 관리비·공과금이면 경비, 집이면 사업 무관');
  if (/손\d|손해보험|손보|KB손|롯손|삼성화재|현대해상|DB손|메리츠|한화손|흥국|화재|생명|보험/.test(m0) && !isIn) return out('보험료', '', m0, '확인', '사업용 차량·사업장 보험이면 경비, 개인 보험이면 사업 무관');
  if (isIn) {
    const nm = bkName_(m0);
    if (ctx.names[nm]) return out('가불 회수', '', nm, '확인', '기사에게서 들어온 돈 — 가불 회수인지 확인');
    if (ctx.owner && m0.indexOf(ctx.owner) >= 0) return out('대표 입금', '', ctx.owner, '확인');
  } else if (ctx.owner && m0.indexOf(ctx.owner) >= 0) return out('대표 인출', '', ctx.owner, '확인');
  // 5) 거래 성격으로 짐작 (확인 필요)
  if (/세무사|세무회계|회계사|기장/.test(m0)) return out('세무·회계', '', m0, '자동');
  if (/캐피탈|리스|할부|파이낸셜|오토/.test(m0)) return out('차량 리스·할부', '', m0, '확인');
  if (/협회|조합/.test(m0)) return out('협회비', '', m0, '확인');
  if (/주유|SK에너지|GS칼텍스|에쓰오일|S-OIL|오일뱅크|충전/.test(m0)) return out('유류비', '', m0, '확인');
  if (/통신|KT|SKT|LGU|유플러스|구글|GOOGLE|네이버|클라우드|비즈니스온|카카오워크/.test(m0)) return out('통신', '', m0, '확인');
  if (/카드결제|카드대금|카드출금|카드선결제|카드\(주\)|카드$/.test(m0) || /카드/.test(kind) && !/체크카드/.test(kind)) return out('카드 대금', '', m0, '확인', '사업용 카드면 카드사 내역으로 세무사 확인');
  if (/체크카드/.test(kind)) return out('운영비', '', m0, '확인', '체크카드 — 분류를 골라 주세요 (식대·소모품·유류비 …)');
  if (/대출이자|이자/.test(m0) && !isIn) return out('이자·수수료', '', m0, '확인', '사업 대출이면 경비');
  if (/수수료/.test(m0) && !isIn) return out('이자·수수료', '', m0, '자동');
  if (/지로/.test(kind) || /지로|우체국/.test(m0)) return out('미분류', '', m0, '미분류', '지로 납부 — 사업장 공과금이면 운영비, 개인이면 사업 무관');
  return out('미분류', '', m0, '미분류');
}
/** 거래내용에서 사람 이름 부분: '김기화(개인용달)' → '김기화', '이용(김대현)가불금' → '이용(김대현)' 는 그대로 두되 괄호 앞 이름도 시도 */
function bkName_(m0) { return str_(m0).replace(/\(.*?\)/g, '').replace(/[^가-힣A-Za-z]/g, '').slice(0, 12); }
function bkYm_(m) { const p = str_(m).split('-'); return p.length === 2 ? Number(p[0]) + '년 ' + Number(p[1]) + '월' : m; }
/** 쿠팡 입금 → 정산월: 입금일이 속한 달의 전월 정산 (10월 정산 → 11월 10일쯤 입금). 금액이 계산 금액과 가까우면 확정 */
function bkDepositMonth_(date, amt, deposits) {
  const d = str_(date).slice(0, 7); if (!d) return { month: '', hint: '' };
  const cands = [stlAddMonth_(d, -1), d, stlAddMonth_(d, -2)];
  let best = null;
  cands.forEach(function (m) { const p = deposits[m]; if (p == null) return; const diff = Math.abs(p - amt); if (!best || diff < best.diff) best = { month: m, diff: diff, plan: p }; });
  if (best && best.diff <= Math.max(1000, best.plan * 0.02)) return { month: best.month, hint: best.diff ? '계산 금액 ' + won_(best.plan) + '원 (차이 ' + won_(amt - best.plan) + ')' : '' };
  return { month: cands[0], hint: best ? '계산 금액 ' + won_(best.plan) + '원과 차이 큼 — 정산월 확인' : '정산 계산 없음 — 정산월 확인' };
}
/** 분류에 필요한 자료 모으기 (정산월 범위는 올린 날짜 ± 3개월) */
function bkContext_(rows) {
  const D = stlDrivers_(), names = {};
  D.all.forEach(function (o) { if (o.name) (names[o.name] = names[o.name] || []).push(o.id); });
  const staff = {}; stlRead_('stl_staff').forEach(function (r) { if (r.name) staff[r.name] = r; });
  const banks = {}; stlBanks_().forEach(function (b) { const d = str_(b.account).replace(/\D/g, ''); if (d.length >= 4) { banks[d.slice(0, 4)] = banks[d.slice(0, 4)] || b; banks[d.slice(-4)] = b; } });
  let owner = ''; try { owner = str_(companyInfo_().branchCeo); } catch (e) { /* 없음 */ }
  const dates = rows.map(function (r) { return str_(r.date); }).filter(Boolean).sort();
  const nets = {}, deposits = {};
  if (dates.length) {
    const from = stlAddMonth_(dates[0].slice(0, 7), -3), to = stlAddMonth_(dates[dates.length - 1].slice(0, 7), 1);
    const months = stlMonths_().withData.filter(function (m) { return m >= from && m <= to; });
    months.forEach(function (m) {
      try {
        const res = stlResult_(m, false), sum = res.summary, c = sum.company || {};
        (sum.drivers || []).forEach(function (d) { if (!d.net) return; const id = d.ownerId || d.id; (nets[id] = nets[id] || []).push({ month: m, id: d.id, name: d.name, net: d.net }); if (d.ownerId && d.ownerId !== d.id) (nets[d.id] = nets[d.id] || []).push({ month: m, id: d.id, name: d.name, net: d.net }); });
        deposits[m] = Math.round((c.supplyCp || 0) * 1.1 - (c.lossCp || 0));
      } catch (e) { /* 그 달 자료 없음 */ }
    });
  }
  // 명의자 이름 → 정산 id 도 names 에 (기사 정보에 없는 명의자·용차업체)
  Object.keys(nets).forEach(function (id) { nets[id].forEach(function (x) { if (x.name && !names[x.name]) names[x.name] = [id]; }); });
  return { D: D, names: names, staff: staff, banks: banks, nets: nets, deposits: deposits, rules: bkRules_(), owner: owner };
}
/** 미리보기: rows(클라이언트가 파일에서 읽은 줄) → 분류 붙여 돌려줌. 이미 저장된 줄은 saved=true */
function adm_bankPreview(token, p) {
  return run_(function () {
    requireAdmin_(token);
    const rows = (p && Array.isArray(p.rows) ? p.rows : []).map(function (r) {
      return { bank: str_(r.bank || p.bank), acct4: bkAcct4_(r.acct || p.acct), date: stlYmd_(r.date), time: str_(r.time), io: r.io === '입금' || stlNum_(r.amt) > 0 && r.io !== '출금' ? '입금' : '출금', amt: Math.abs(stlNum_(r.amt)), bal: stlNum_(r.bal), memo: str_(r.memo).slice(0, 60), kind: str_(r.kind).slice(0, 20) };
    }).filter(function (r) { return r.date && r.amt; });
    if (!rows.length) fail_('읽은 거래 줄이 없습니다.');
    const ctx = bkContext_(rows);
    const months = {}; rows.forEach(function (r) { months[bkMonth_(r.date)] = 1; });
    const saved = {};
    Object.keys(months).forEach(function (m) { stlReadMonth_('stl_bankrows', m).forEach(function (x) { saved[x.key] = x; }); });
    // 한 번에 여러 통장을 붙여 넣을 수 있다 → 계좌 끝4자리마다 올인원 통장 추정
    const accts = {};
    rows.forEach(function (r) { const a = accts[r.acct4] || (accts[r.acct4] = { acct4: r.acct4, bank: r.bank, n: 0, bankName: (ctx.banks[r.acct4] || {}).name || '', from: r.date, to: r.date }); a.n++; if (r.date < a.from) a.from = r.date; if (r.date > a.to) a.to = r.date; });
    const bankName = (ctx.banks[rows[0].acct4] || {}).name || '';
    const out = rows.map(function (r) {
      const k = bkKey_(r), old = saved[k];
      const c = old && old.cat && old.status !== '미분류' ? { cat: old.cat, ref: old.ref, refName: old.refName, status: old.status, hint: '' } : bkClassify_(r, ctx);
      return Object.assign({}, r, { key: k, cat: c.cat, ref: c.ref, refName: c.refName, status: c.status, hint: c.hint, saved: !!old, bankName: accts[r.acct4].bankName });
    });
    const cnt = { total: out.length, auto: 0, check: 0, none: 0, saved: 0 };
    out.forEach(function (r) { if (r.saved) cnt.saved++; if (r.status === '자동') cnt.auto++; else if (r.status === '확인') cnt.check++; else cnt.none++; });
    return { ok: true, rows: out, cnt: cnt, bankName: bankName, acct4: rows[0].acct4, accts: Object.keys(accts).map(function (k) { return accts[k]; }), months: Object.keys(months).sort(), cats: BK_CATS, banks: stlBanks_().map(function (b) { return { name: b.name, role: b.role, acct4: str_(b.account).replace(/\D/g, '').slice(-4) }; }) };
  });
}
/**
 * 저장: rows(미리보기에서 분류를 고친 것) + opt { bankName, learn(규칙 기억), payCheck(기사 입금체크), deposit(쿠팡 입금 확인), expense(지출 기록) }
 */
function adm_bankSave(token, p) {
  return run_(function () {
    const a = requireAdmin_(token);
    const rows = (p && Array.isArray(p.rows) ? p.rows : []).filter(function (r) { return r && r.key && r.date; });
    if (!rows.length) fail_('저장할 줄이 없습니다.');
    const opt = p.opt || {}, bankName = str_(p.bankName || opt.bankName), now = nowText_();
    const lock = scriptLock_(); lock.waitLock(30000);
    const res = { ok: true, saved: 0, replaced: 0, rules: 0, pay: 0, deposit: 0, expense: 0 };
    try {
      stlFreshIn_('stl_bankrules'); stlFreshIn_('stl_pay'); stlFreshIn_('stl_fund'); stlFreshIn_('stl_expense');
      // 1) 줄 저장 (거래 달 단위로 합치기)
      const byM = {};
      rows.forEach(function (r) { (byM[bkMonth_(r.date)] = byM[bkMonth_(r.date)] || []).push(r); });
      Object.keys(byM).forEach(function (m) {
        const cur = {}; stlReadMonth_('stl_bankrows', m).forEach(function (x) { cur[x.key] = x; });
        byM[m].forEach(function (r) {
          if (cur[r.key]) res.replaced++; else res.saved++;
          cur[r.key] = { month: m, key: r.key, bank: str_(r.bank), acct4: str_(r.acct4), bankName: str_(r.bankName) || bankName, date: r.date, time: str_(r.time), io: r.io, amt: stlNum_(r.amt), bal: stlNum_(r.bal), memo: str_(r.memo), kind: str_(r.kind),
            cat: BK_CATS.indexOf(r.cat) >= 0 ? r.cat : '미분류', ref: str_(r.ref), refName: str_(r.refName), status: r.cat && r.cat !== '미분류' ? (r.status === '자동' ? '자동' : '확인됨') : '미분류', note: str_(r.note), at: now };
        });
        const list = Object.keys(cur).map(function (k) { return cur[k]; }).sort(function (a, b) { return koCmp_(a.date + a.time, b.date + b.time); });
        stlReplaceMonth_('stl_bankrows', m, list);
      });
      // 2) 규칙 기억: 사용자가 고른(확인됨) 줄의 거래내용 패턴 → 분류
      if (opt.learn !== false) {
        const rules = stlRead_('stl_bankrules'), have = {};
        rules.forEach(function (x) { have[x.pattern] = x; });
        let changed = false;
        rows.forEach(function (r) {
          if (!r.cat || r.cat === '미분류' || r.cat === '기사 정산' || r.cat === '쿠팡 입금' || r.cat === '내부 이체' || r.status === '자동') return;
          const pat = bkNorm_(r.memo); if (!pat) return;
          if (have[pat] && have[pat].cat === r.cat) return;
          if (have[pat]) { have[pat].cat = r.cat; have[pat].refName = str_(r.refName); have[pat].at = now; } else { const nr = { pattern: pat, cat: r.cat, refName: str_(r.refName), at: now }; rules.push(nr); have[pat] = nr; }
          changed = true; res.rules++;
        });
        if (changed) stlWriteAll_('stl_bankrules', rules.map(function (x) { return { pattern: x.pattern, cat: x.cat, refName: x.refName, at: x.at }; }));
      }
      // 3) 기사 입금체크
      if (opt.payCheck) {
        const byMonth = {};
        rows.forEach(function (r) { if (r.cat !== '기사 정산' || !r.ref || r.ref.indexOf('|') < 0) return; const mp = r.ref.split('|'); (byMonth[mp[0]] = byMonth[mp[0]] || []).push({ id: mp[1], date: r.date }); });
        Object.keys(byMonth).forEach(function (m) {
          const pay = stlRead_('stl_pay'), idx = {}; pay.forEach(function (x, i) { if (x.month === m) idx[stlLogin_(x.acct)] = i; });
          let touched = false;
          byMonth[m].forEach(function (x) {
            const i = idx[stlLogin_(x.id)];
            if (i >= 0) { if (!stlYes_(pay[i].checked)) { pay[i].checked = 'Y'; pay[i].date = x.date; pay[i].memo = str_(pay[i].memo) || '통장 내역 자동'; touched = true; res.pay++; } }
            else { pay.push({ month: m, acct: x.id, name: '', checked: 'Y', date: x.date, memo: '통장 내역 자동' }); touched = true; res.pay++; }
          });
          if (touched) stlWriteAll_('stl_pay', pay.map(function (x) { return { month: x.month, acct: x.acct, name: x.name, checked: x.checked, date: x.date, memo: x.memo }; }));
        });
      }
      // 4) 쿠팡 입금 확인 (stl_fund '쿠팡 입금' 줄: 금액·날짜·완료)
      if (opt.deposit) {
        // 같은 정산월 입금이 나눠 들어오면(1차·2차) 더해서 · 탭은 마지막에 한 번만 씀
        const dep = {};
        rows.forEach(function (r) {
          if (r.cat !== '쿠팡 입금' || !r.ref) return;
          const d = dep[r.ref] || (dep[r.ref] = { amt: 0, date: '', bank: str_(r.bankName) || bankName });
          d.amt += stlNum_(r.amt); if (str_(r.date) > d.date) d.date = str_(r.date);
          res.deposit++;
        });
        if (Object.keys(dep).length) {
          const fund = stlRead_('stl_fund');
          Object.keys(dep).forEach(function (m) {
            const d = dep[m], row = fund.filter(function (x) { return x.month === m && x.item === '쿠팡 입금'; })[0];
            if (row) { row.amt = d.amt; row.date = d.date; row.done = 'Y'; row.memo = str_(row.memo) || '통장 내역 자동'; }
            else fund.push({ month: m, item: '쿠팡 입금', bank: d.bank, plan: '', amt: d.amt, done: 'Y', date: d.date, memo: '통장 내역 자동' });
          });
          stlWriteAll_('stl_fund', fund.map(function (x) { return { month: x.month, item: x.item, bank: x.bank, plan: x.plan, amt: x.amt, done: x.done, date: x.date, memo: x.memo }; }));
        }
      }
      // 5) 지출 기록 (중복 방지: 메모에 [통장:키])
      if (opt.expense) {
        const exp = stlRead_('stl_expense'), have = {};
        exp.forEach(function (x) { const m = str_(x.memo).match(/\[통장:([^\]]+)\]/); if (m) have[m[1]] = 1; });
        const add = [];
        rows.forEach(function (r) {
          const cat = BK_EXPENSE_CAT[r.cat]; if (!cat || r.io !== '출금' || have[r.key]) return;
          add.push({ month: bkMonth_(r.date), date: r.date, cat: cat, name: str_(r.refName || r.memo).slice(0, 40), vendor: str_(r.memo).slice(0, 30), amt: stlNum_(r.amt), proof: /체크카드/.test(str_(r.kind)) ? '카드' : '', bank: str_(r.bankName) || bankName, memo: '[통장:' + r.key + ']' + (r.note ? ' ' + r.note : '') });
          have[r.key] = 1;
        });
        if (add.length) { stlAppend_('stl_expense', add); res.expense = add.length; }
      }
    } finally { lock.releaseLock(); }
    try { logAdmin_(a, '통장 내역 올림', bankName, rows.length + '줄 (새로 ' + res.saved + ' · 덮어씀 ' + res.replaced + ' · 입금체크 ' + res.pay + ' · 지출 기록 ' + res.expense + ')'); } catch (e) { /* 무시 */ }
    return res;
  });
}
/** 저장된 통장 내역 (월별) · 분류 고치기 */
function adm_bankList(token, month) {
  return run_(function () {
    requireAdmin_(token);
    if (!/^\d{4}-\d{2}$/.test(str_(month))) fail_('월을 확인해 주세요.');
    const rows = stlReadMonth_('stl_bankrows', month).map(function (x) { return Object.assign({}, x, { amt: stlNum_(x.amt), bal: stlNum_(x.bal) }); })
      .sort(function (a, b) { return koCmp_(a.bankName + a.date + a.time, b.bankName + b.date + b.time); });
    const sum = {}; rows.forEach(function (r) { const s = sum[r.cat] = sum[r.cat] || { cat: r.cat, in: 0, out: 0, n: 0 }; s.n++; if (r.io === '입금') s.in += r.amt; else s.out += r.amt; });
    const ix = stlIndex_('stl_bankrows');
    return { ok: true, month: month, rows: rows, sum: Object.keys(sum).map(function (k) { return sum[k]; }), months: Object.keys(ix.m).sort(), cats: BK_CATS };
  });
}
function adm_bankSetCat(token, month, list) {
  return run_(function () {
    requireAdmin_(token);
    const lock = scriptLock_(); lock.waitLock(30000);
    try {
      const cur = stlReadMonth_('stl_bankrows', month).slice(), by = {}; cur.forEach(function (x, i) { by[x.key] = i; });
      let n = 0;
      (list || []).forEach(function (u) { const i = by[u.key]; if (i == null) return; cur[i] = Object.assign({}, cur[i], { cat: BK_CATS.indexOf(u.cat) >= 0 ? u.cat : cur[i].cat, refName: u.refName != null ? str_(u.refName) : cur[i].refName, note: u.note != null ? str_(u.note) : cur[i].note, status: '확인됨' }); n++; });
      stlReplaceMonth_('stl_bankrows', month, cur);
      return { ok: true, n: n };
    } finally { lock.releaseLock(); }
  });
}
function adm_bankDelete(token, month, keys) {
  return run_(function () {
    requireAdmin_(token);
    const lock = scriptLock_(); lock.waitLock(30000);
    try {
      const del = {}; (keys || []).forEach(function (k) { del[k] = 1; });
      const cur = stlReadMonth_('stl_bankrows', month).filter(function (x) { return !del[x.key]; });
      stlReplaceMonth_('stl_bankrows', month, cur);
      return { ok: true, left: cur.length };
    } finally { lock.releaseLock(); }
  });
}
