// VIP 강의 페이지 빌드 스크립트
// 1) 인프런 강사 페이지·유튜브에서 최신 수치(가격·할인·평점·수강생·조회수)를 가져오고
// 2) data/snapshot.json에 저장한 뒤
// 3) site.config.json(강의 순서·문구) + scripts/style.css로 index.html을 다시 만듭니다.
// 가져오기에 실패한 항목은 직전 snapshot 값을 그대로 씁니다. (외부 의존성 없음, Node 18+)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const P = (...a) => path.join(ROOT, ...a);
const cfg = JSON.parse(fs.readFileSync(P('site.config.json'), 'utf8'));
const SNAP = P('data', 'snapshot.json');
const prev = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, 'utf8')) : { courses: {}, instructor: {}, youtube: { views: {} } };
const FIX = process.env.VIP_FIXTURES; // 로컬 테스트용
const fixMap = FIX ? JSON.parse(fs.readFileSync(path.join(FIX, 'map.json'), 'utf8')) : null;
const log = (...a) => console.log('[vip]', ...a);

async function getText(url) {
  if (fixMap) {
    const f = fixMap[url];
    if (!f) throw new Error('no fixture ' + url);
    return fs.readFileSync(path.join(FIX, f), 'utf8');
  }
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Cookie': 'CONSENT=YES+1; PREF=hl=ko&gl=KR'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}
const nextData = (html) => JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
const findQuery = (nd, re) => (nd.props?.pageProps?.dehydratedState?.queries || []).find(q => re.test(JSON.stringify(q.queryKey)));

function fromListItem(it) {
  const c = it.course, lp = it.listPrice || {};
  return {
    id: c.id, slug: c.slug, title: c.title.trim(), desc: c.description || '', thumb: c.thumbnailUrl,
    star: c.star, reviews: c.reviewCount, students: c.studentCount, runtimeMin: Math.round((c.runtimeSecond || 0) / 60),
    level: c.metadata?.levelCode || '', abilities: c.abilities || [], categories: c.metadata?.childCategories || [],
    isNew: !!c.isNew, publishedAt: c.publishedAtUTC || null,
    // 해외(예: GitHub 서버)에서 접속하면 regularPrice/payPrice가 달러로 오므로 원화(krw) 값을 씁니다.
    regular: it.krwRegularPrice ?? lp.regularPrice ?? 0, pay: it.krwPaymentPrice ?? lp.payPrice ?? 0, isFree: !!lp.isFree,
    discount: lp.isDiscount && lp.discountRate ? { rate: lp.discountRate, title: lp.discountTitle || '할인', endUTC: lp.discountEndedAtUTC || null } : null
  };
}
function fromCoursePage(nd, slug) {
  const info = findQuery(nd, /\/online\/info/)?.state?.data?.data;
  if (!info) throw new Error('no online/info');
  const pi = info.paymentInfo || {}, d = pi.discount || null;
  const rate = pi.discountRate || 0;
  return {
    id: info.id, slug: info.slug || slug, title: info.title.trim(), desc: info.description || '', thumb: info.thumbnailUrl,
    star: info.review?.averageStar ?? 0, reviews: info.review?.count ?? 0, students: info.studentCount,
    runtimeMin: Math.round((info.unitSummary?.runtime || 0) / 60), level: info.levels?.find(l => l.isActive)?.code || '',
    abilities: [], categories: [info.category?.sub?.title].filter(Boolean), isNew: !!info.isNew, publishedAt: info.publishedAtUTC || null,
    regular: pi.krwRegularPrice ?? pi.regularPrice ?? 0, pay: pi.krwPaymentPrice ?? pi.payPrice ?? 0, isFree: (pi.krwRegularPrice ?? pi.regularPrice ?? 0) === 0,
    discount: rate ? { rate, title: d?.title || '할인', endUTC: d?.endedAtUTC || d?.endedAt || null } : null
  };
}

async function fetchInflearn() {
  const out = { courses: {}, instructor: null, order: [] };
  const html = await getText(cfg.inflearnUserUrl);
  const nd = nextData(html);
  const list = findQuery(nd, /course\/user/)?.state?.data?.pages?.[0]?.data;
  for (const it of list?.items || []) { const c = fromListItem(it); out.courses[c.id] = c; out.order.push(c.id); }
  // 안전장치: 유료 강의 가격이 1,000원 미만이면(통화 오류 등) 이번 결과를 버립니다.
  if (Object.values(out.courses).some(c => !c.isFree && (c.regular < 1000 || c.pay < 1000))) throw new Error('price sanity check failed (non-KRW?)');
  const ins = findQuery(nd, /instructors\/\d+\/profile/)?.state?.data?.data;
  if (ins) out.instructor = { rating: Number(ins.reviewAverage), reviews: ins.reviewCount, students: ins.studentCount, courseCount: ins.courseCount };
  // 첫 페이지(12개)에 없는 강의는 강의 페이지에서 따로 읽습니다.
  const wanted = new Set([...Object.keys(prev.courses || {}), ...Object.keys(cfg.knownSlugs || {})].map(Number));
  for (const id of wanted) {
    if (out.courses[id]) continue;
    const slug = prev.courses?.[id]?.slug || cfg.knownSlugs?.[id];
    if (!slug) continue;
    try { const c = fromCoursePage(nextData(await getText('https://www.inflearn.com/course/' + encodeURIComponent(slug))), slug); if (!c.isFree && c.regular < 1000) throw new Error('non-KRW price'); out.courses[id] = c; }
    catch (e) { log('course page fail', id, e.message); }
  }
  return out;
}
async function fetchYouTube() {
  const ids = [...new Set([...(cfg.featured.videos || []).map(v => v.id), ...(cfg.featured.seriesVideoIds || [])])];
  const views = {}; let subs = null;
  for (const id of ids) {
    try { const t = await getText('https://www.youtube.com/watch?v=' + id); const m = t.match(/"viewCount":"(\d+)"/); if (m) views[id] = +m[1]; }
    catch (e) { log('yt view fail', id, e.message); }
  }
  try {
    const t = await getText(cfg.youtubeChannel);
    const m = t.match(/구독자 ([\d.,]+)(만|천)?명/);
    if (m) subs = Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] === '만' ? 10000 : m[2] === '천' ? 1000 : 1));
  } catch (e) { log('yt channel fail', e.message); }
  return { views, subs };
}

// ---------- 데이터 병합 ----------
let inf = null, yt = null;
try { inf = await fetchInflearn(); log('inflearn ok', Object.keys(inf.courses).length, 'courses'); } catch (e) { log('inflearn FAIL, keep previous:', e.message); }
try { yt = await fetchYouTube(); log('youtube ok', Object.keys(yt.views).length, 'videos, subs', yt.subs); } catch (e) { log('youtube FAIL', e.message); }

const data = {
  courses: { ...(prev.courses || {}), ...(inf?.courses || {}) },
  order: inf?.order?.length ? inf.order : (prev.order || []),
  instructor: inf?.instructor || prev.instructor || {},
  youtube: { subs: yt?.subs || prev.youtube?.subs || null, views: { ...(prev.youtube?.views || {}), ...(yt?.views || {}) } }
};
const hash = crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
const changed = hash !== prev.hash;
data.hash = hash;
data.updatedAt = changed ? new Date().toISOString() : (prev.updatedAt || new Date().toISOString());
fs.mkdirSync(P('data'), { recursive: true });
fs.writeFileSync(SNAP, JSON.stringify(data, null, 1));
log(changed ? 'data changed' : 'data unchanged', data.updatedAt);

// ---------- 렌더링 ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
const N = (n) => Number(n).toLocaleString('ko-KR');
const MONTHS = cfg.installmentMonths || 5;
const monthly = (n) => Math.ceil(n / MONTHS / 10) * 10;
const now = Date.now();
const C = data.courses;
const url = (c) => `https://www.inflearn.com/course/${encodeURIComponent(c.slug)}?cid=${c.id}`;
const img = (u, w) => (/inflearn\.com/.test(u) ? u.split('?')[0] + '?w=' + w : u);
const dur = (m) => { const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}시간${mm ? ' ' + mm + '분' : ''}` : `${mm}분`; };
const activeDisc = (c) => c?.discount && (!c.discount.endUTC || Date.parse(c.discount.endUTC) > now) ? c.discount : null;
const viewsTxt = (v) => v >= 100000 ? Math.floor(v / 10000) + '만' : v >= 10000 ? (Math.floor(v / 1000) / 10) + '만' : N(v);
const shortT = (t) => t.split(/[:：–\-(]/)[0].trim();

function priceBlock(c, cls = 'price mp') {
  if (!c || c.isFree) return '<div class="price"><b class="fr">무료</b></div>';
  const d = activeDisc(c);
  const end = d?.endUTC ? ` data-end="${esc(d.endUTC)}"` : '';
  if (d) return `<div class="${cls}" data-reg="${c.regular}" data-pay="${c.pay}" data-rate="${d.rate}"${end}><div class="mline"><span class="rate">${d.rate}%</span><span class="mo">월</span><b>${N(monthly(c.pay))}원</b></div><div class="sub">${MONTHS}개월 할부 · 총 ${won(c.pay)} <s>${won(c.regular)}</s></div></div>`;
  return `<div class="${cls}" data-reg="${c.regular}" data-pay="${c.regular}"><div class="mline"><span class="mo">월</span><b>${N(monthly(c.regular))}원</b></div><div class="sub">${MONTHS}개월 할부 · 총 ${won(c.regular)}</div></div>`;
}
const metaLine = (c) => `<div class="meta">${c.reviews ? `<span class="star">★ ${Number(c.star).toFixed(1)}</span><span>(${N(c.reviews)})</span><span>·</span>` : '<span class="nw">NEW</span><span>·</span>'}<span>${N(c.students)}명</span><span>·</span><span>${dur(c.runtimeMin)}</span></div>`;
function card(c, opt = {}) {
  if (!c) return '';
  const badge = c.isFree ? '<span class="free">무료</span>' : activeDisc(c) ? `<span class="free sale"${activeDisc(c).endUTC ? ` data-end="${esc(activeDisc(c).endUTC)}"` : ''}>${activeDisc(c).rate}% 할인</span>` : '';
  return `<a class="course" href="${url(c)}" target="_blank" rel="noopener"><div class="thumb"><img src="${esc(img(c.thumb, 600))}" alt="${esc(c.title)}" loading="lazy"><span class="ext">↗</span>${badge}</div><div class="cbody"><h3>${esc(c.title)}</h3>${metaLine(c)}${priceBlock(c)}</div></a>`;
}
function extraCard(x) {
  return `<a class="course" href="${esc(x.url)}" target="_blank" rel="noopener"><div class="thumb"><img src="${esc(x.thumb)}" alt="${esc(x.title)}" loading="lazy"><span class="ext">↗</span>${x.platform ? `<span class="free" style="background:#a435f0;color:#fff">${esc(x.platform)}</span>` : x.badge ? `<span class="free">${esc(x.badge)}</span>` : ''}</div><div class="cbody"><h3>${esc(x.title)}</h3><div class="meta">${(x.meta || []).map(m => m.startsWith('★') ? `<span class="star">${esc(m)}</span>` : `<span>${esc(m)}</span>`).join('')}</div>${x.cta ? `<div class="price"><b style="font-size:13.5px;color:#c4b5fd">${esc(x.cta)}</b></div>` : '<div class="price"><b class="fr">무료</b></div>'}</div></a>`;
}

// 신규 강의: 인프런 NEW 표시이거나 공개 후 N일 이내 (대표 강의 제외)
const F = cfg.featured, fc = C[F.id];
const newIds = Object.values(C).filter(c => c.id !== F.id && !c.isFree && (c.isNew || (c.publishedAt && now - Date.parse(c.publishedAt) < (cfg.newCourseDays || 45) * 864e5)))
  .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0)).map(c => c.id);
const placed = new Set([F.id, ...newIds]);

// 할인 배너: 진행 중인 할인 중 할인율이 가장 큰 것
const discs = Object.values(C).filter(c => !c.isFree && activeDisc(c));
const paidCount = Object.values(C).filter(c => !c.isFree).length;
let bar = '';
if (discs.length) {
  const top = discs.sort((a, b) => activeDisc(b).rate - activeDisc(a).rate)[0], d = activeDisc(top);
  const all = discs.length >= paidCount && paidCount > 1;
  const msg = all ? `${d.title}! 모든 강의 최대 ${d.rate}% 할인` : newIds.includes(top.id) ? `신규 강의 ${d.title} ${d.rate}%` : `${d.title} ${d.rate}% · ${shortT(top.title)}`;
  const href = all ? cfg.inflearnUserUrl : url(top);
  bar = `<div class="bar" id="bar"${d.endUTC ? ` data-end="${esc(d.endUTC)}"` : ''}><div class="in"><span class="tag">${d.rate}% OFF</span><span class="msg">🎉 ${esc(msg)}</span><span class="t" id="cd"></span></div><a class="go" href="${href}" target="_blank" rel="noopener">${all ? '할인가로 강의 보기 →' : '할인가로 보러가기 →'}</a></div>`;
}

const views = data.youtube.views || {};
const seriesViews = (F.seriesVideoIds || []).reduce((s, id) => s + (views[id] || 0), 0);
const featBadge = F.badgeTemplate.replace('{views}', seriesViews >= 10000 ? Math.floor(seriesViews / 10000) + '만' : N(seriesViews));
const featured = fc ? `<div class="lab"><i>01</i>⭐ 해피AI 대표 강의</div>
<div class="feat"><div class="fbadge">${esc(featBadge)}</div>
<a class="fthumb" href="${url(fc)}" target="_blank" rel="noopener"><img src="${esc(img(fc.thumb, 960))}" alt="${esc(fc.title)}"><span class="ribbon">${esc(F.ribbon)}</span></a>
<div class="fbody"><h2>${esc(fc.title)}</h2><p class="fdesc">${F.descHtml}</p>
<div class="fmeta"><span class="star">★ ${Number(fc.star).toFixed(1)}</span><span>(${N(fc.reviews)})</span><span>·</span><span>${N(fc.students)}명 수강</span><span>·</span><span>${dur(fc.runtimeMin)}</span><span>·</span><span>${esc(F.level)}</span></div>
<div class="flearn"><div class="ft">이런 걸 할 수 있게 돼요</div>${F.learn.map(l => `<div class="fl"><span>✓</span>${esc(l)}</div>`).join('')}</div>
<div class="ffor">${F.for.map(f => `<span>${esc(f)}</span>`).join('')}</div>
<div class="fyt"><div class="ft">유튜브에서 먼저 확인해 보세요</div>${F.videos.map(v => `<a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener"><span class="yp">▶</span><span class="yt">${esc(v.title)}</span>${views[v.id] ? `<span class="yv">${viewsTxt(views[v.id])} 회</span>` : ''}</a>`).join('')}</div>
${priceBlock(fc, 'fprice price mp')}
<a class="btn fcta" href="${url(fc)}" target="_blank" rel="noopener">${esc(F.cta)}</a></div></div>` : '';

let secNo = 1;
const lab = (t) => `<div class="lab"><i>${String(++secNo).padStart(2, '0')}</i>${t}</div>`;
const newBlock = newIds.length ? lab('✨ 새로 나온 강의') + newIds.map(id => {
  const c = C[id], d = activeDisc(c), note = cfg.courseNotes?.[id] || {};
  const abil = (c.abilities || []).map(a => a.split(':')[0].trim()).filter(Boolean).slice(0, 6);
  return `<div class="newc"><a class="fthumb" href="${url(c)}" target="_blank" rel="noopener"><img src="${esc(img(c.thumb, 960))}" alt="${esc(c.title)}" loading="lazy"><span class="ribbon nr">NEW</span>${d ? `<span class="ribbon sr"${d.endUTC ? ` data-end="${esc(d.endUTC)}"` : ''}>${esc(d.title)} ${d.rate}%</span>` : ''}</a>
<div class="fbody"><h2>${esc(c.title)}</h2><p class="fdesc">${esc(note.hook || c.desc)}</p>
<div class="fmeta">${note.tag ? `<span class="tg">${esc(note.tag)}</span>` : ''}<span>${N(c.students)}명 수강</span><span>·</span><span>${dur(c.runtimeMin)}</span>${c.reviews ? `<span>·</span><span class="star">★ ${Number(c.star).toFixed(1)}</span><span>(${N(c.reviews)})</span>` : ''}</div>
${note.sub ? `<div class="nsub">${esc(note.sub)}</div>` : ''}
${abil.length ? `<div class="flearn"><div class="ft">이런 걸 배워요</div>${abil.map(a => `<div class="fl"><span>✓</span>${esc(a)}</div>`).join('')}</div>` : ''}
${d && d.endUTC ? `<div class="ebird" data-end="${esc(d.endUTC)}">⏰ ${esc(d.title)} 마감까지 <b class="cdx">-</b></div>` : ''}
${priceBlock(c, 'fprice price mp')}
<a class="btn ncta"${d && d.endUTC ? ` data-end="${esc(d.endUTC)}"` : ''} href="${url(c)}" target="_blank" rel="noopener">${d ? esc(d.title) + ' 가격으로 보러가기 →' : '강의 보러가기 →'}</a></div></div>`;
}).join('') : '';

const R = cfg.roadmap;
const rcs = R.steps.map(s => C[s.id]).filter(Boolean);
const rReg = rcs.reduce((s, c) => s + c.regular, 0), rPay = rcs.reduce((s, c) => s + (activeDisc(c) ? c.pay : c.regular), 0);
const roadmap = lab('🧭 추천 학습 로드맵') + `<div class="road"><h3>${esc(R.title)}</h3><p>${esc(R.desc)}</p>
<div class="steps">${R.steps.map((s, i) => { const c = C[s.id]; return c ? `<a class="step" href="${url(c)}" target="_blank" rel="noopener"><span class="n">${i + 1}</span><span class="t">${esc(s.label)}</span><span class="s">★ ${Number(c.star).toFixed(1)} ↗</span></a>` : ''; }).join('')}</div>
<div class="tot mp" data-reg="${rReg}" data-pay="${rPay}"><div class="mline"><span class="lbl">${rcs.length}개 강의 모두</span><span class="mo">월</span><b>${N(monthly(rPay))}원</b></div><div class="sub">${MONTHS}개월 할부 · 총 ${won(rPay)}${rPay < rReg ? ` <s>${won(rReg)}</s>` : ''}</div></div></div>`;

// 설정에 없는 새 유료 강의는 자동으로 알맞은 섹션 끝에 붙입니다.
const secIds = cfg.sections.map(s => [...s.ids]);
for (const c of Object.values(C)) {
  if (c.isFree || placed.has(c.id) || secIds.some(a => a.includes(c.id))) continue;
  const isData = /데이터|텍스트|텍스톰|분석|머신러닝/.test(c.title + c.categories.join(' '));
  secIds[isData ? 1 : 0].push(c.id);
}
const sections = cfg.sections.map((s, i) => {
  const ids = secIds[i].filter(id => C[id] && !placed.has(id));
  const cards = ids.map(id => card(C[id])).join('') + (s.extra || []).map(k => extraCard(cfg.extraCards[k])).join('');
  return cards ? lab(s.label) + `<div class="grid2">${cards}</div>` : '';
}).join('');

const free = Object.values(C).filter(c => c.isFree).sort((a, b) => b.students - a.students);
const freeHtml = `<div class="lab"><i>01</i>🎁 무료 강의</div><div class="grid2">${(cfg.freeExtra || []).map(extraCard).join('')}${free.map(c => card(c)).join('')}</div>`;
const freeCount = free.length + (cfg.freeExtra || []).length;

const I = data.instructor || {};
const subsTxt = data.youtube.subs ? (data.youtube.subs >= 10000 ? (Math.floor(data.youtube.subs / 1000) / 10) + '만' : N(data.youtube.subs)) : '1.3만';
const upd = new Date(data.updatedAt);
const kst = new Date(upd.getTime() + 9 * 3600e3);
const updTxt = `${kst.getUTCFullYear()}.${String(kst.getUTCMonth() + 1).padStart(2, '0')}.${String(kst.getUTCDate()).padStart(2, '0')} ${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;

const B = cfg.biz;
const allForLd = [F.id, ...newIds, ...R.steps.map(s => s.id), ...secIds.flat(), ...free.map(c => c.id)].filter((v, i, a) => C[v] && a.indexOf(v) === i);
const ld = { '@context': 'https://schema.org', '@graph': [
  { '@type': 'ItemList', '@id': 'https://vip.happyaidata.kr/#courses', name: '해피AI 이진규 AI 강의 목록', itemListElement: allForLd.map((id, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@type': 'Course', name: C[id].title, description: `${C[id].title} | AI공학박사 이진규(해피AI) 온라인 강의`, url: url(C[id]), inLanguage: 'ko', provider: { '@type': 'Organization', name: '인프런', sameAs: 'https://www.inflearn.com/' }, author: { '@id': 'https://www.happyaidata.kr/#jinkyu' } } })) },
  { '@type': 'Person', '@id': 'https://www.happyaidata.kr/#jinkyu', name: '이진규', alternateName: 'Lee JinKyu', jobTitle: '해피AI 대표 · AI공학박사 · AI소프트웨어학과 겸임교수', worksFor: { '@id': 'https://www.happyaidata.kr/#org' }, url: 'https://vip.happyaidata.kr/', sameAs: ['https://www.youtube.com/@HappyAI_0612', 'https://www.inflearn.com/users/846696', 'https://www.udemy.com/user/ijingyu-17/', 'https://github.com/leejin-kyu', 'https://blog.naver.com/happynlp0612', 'https://jinkyu0612.tistory.com/'] },
  { '@id': 'https://www.happyaidata.kr/#org', '@type': 'Organization', name: '해피AI', url: 'https://www.happyaidata.kr/' }
] };
const descMeta = `유튜브 해피AI 구독자를 위한 강의 페이지. 누적 ${Math.floor(seriesViews / 10000)}만 회+ Claude 업무자동화 강의, LLM 입문부터 AI Agent까지 5단계 로드맵, 무료 강의 ${freeCount}개. AI공학박사 이진규 직강.`;
const title = '해피AI 이진규 강의 모음 | Claude 업무자동화·LLM·RAG·AI Agent 강의';
const ogImg = fc ? img(fc.thumb, 1200) : '';

const EXTRA_CSS = `.free.sale{background:#f472b6;color:#1f0414}.meta .nw{color:#f472b6;font-weight:800}
.newc{border:1px solid rgba(244,114,182,.45);border-radius:20px;overflow:hidden;background:linear-gradient(180deg,rgba(131,24,67,.35),rgba(15,23,42,.92) 38%);box-shadow:0 10px 40px rgba(236,72,153,.13);margin-bottom:12px}
.ribbon.nr{background:#ec4899}.ribbon.sr{left:auto;right:12px;background:#fbbf24;color:#1c1917}
.fmeta .tg{background:rgba(129,140,248,.18);color:#c7d2fe;border-radius:6px;padding:1px 7px;font-weight:800}
.nsub{margin-top:8px;font-size:12.5px;color:#a5b4fc}
.ebird{margin-top:14px;text-align:center;font-size:13.5px;font-weight:800;color:#fde68a;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.35);border-radius:10px;padding:9px}.ebird b{font-family:ui-monospace,Menlo,monospace;color:#fff}
.ncta{background:linear-gradient(135deg,#ec4899,#f472b6);color:#1f0414;font-size:15.5px;padding:15px}
.upd{margin-top:10px;font-size:11px;color:#475569}`;
const css = fs.readFileSync(P('scripts', 'style.css'), 'utf8') + '\n' + EXTRA_CSS;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(descMeta)}">
<meta name="keywords" content="해피AI, 이진규, Claude 강의, 클로드 강의, 업무자동화 강의, LLM 강의, RAG 강의, AI Agent 강의, 머신러닝 강의, 인프런 AI 강의, 무료 AI 강의, 텍스트마이닝 강의"><meta name="author" content="이진규 (해피AI)"><meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="https://vip.happyaidata.kr/">
<meta property="og:type" content="website"><meta property="og:site_name" content="해피AI 이진규"><meta property="og:locale" content="ko_KR"><meta property="og:url" content="https://vip.happyaidata.kr/">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(descMeta)}"><meta property="og:image" content="${esc(ogImg)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(descMeta)}"><meta name="twitter:image" content="${esc(ogImg)}">
<link rel="icon" href="https://www.happyaidata.kr/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="https://www.happyaidata.kr/apple-touch-icon.png">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">
<style>
${css}
</style></head><body>
${bar}
<div class="wrap">
<section class="prof"><div class="ptop"><div class="icons"><a href="https://happyaidata.kr" target="_blank" rel="noopener" title="해피AI 홈페이지">⌂</a><button onclick="copyLink()" title="링크 복사">🔗</button></div>
<img class="avatar" src="${esc(cfg.profile.avatar)}" alt="이진규"><h2>${esc(cfg.profile.name)}</h2><div class="role">${esc(cfg.profile.role)}</div><p>${esc(cfg.profile.tagline)}</p></div>
<div class="stats"><div><b>${subsTxt}+</b><span>유튜브 구독자</span></div><div><b>${N(I.students || 0)}</b><span>누적 수강생</span></div><div><b><span class="st">★</span> ${Number(I.rating || 0).toFixed(1)}</b><span>수강평 평점 (${N(I.reviews || 0)})</span></div></div></section>
<nav class="tabs"><button class="on" data-t="paid">강의</button><button data-t="free">무료 강의</button><button data-t="biz">기업 교육</button></nav>
<div class="pane on" id="paid">
<div class="sec-h"><div class="eyebrow">COURSES</div><h1>원리부터 실무까지, AI 강의</h1><p>Claude 업무자동화, LLM·RAG·AI Agent부터 데이터 분석까지 한 곳에서.</p></div><div class="inote">※ 월 금액은 ${MONTHS}개월 할부 기준 예시이며, 실제 할부 조건은 결제 시 카드사에 따라 다릅니다.</div>
${featured}
${newBlock}
${roadmap}
${sections}
</div>
<div class="pane" id="free">
<div class="sec-h"><div class="eyebrow">FREE</div><h1>무료로 먼저 시작해 보세요</h1><p>부담 없이 시작하는 입문 강의 ${freeCount}개.</p></div>
${freeHtml}
</div>
<div class="pane" id="biz">
<div class="sec-h"><div class="eyebrow">FOR BUSINESS</div><h1>기업·기관 교육 및 프로젝트</h1><p>현장에 맞춘 생성형 AI 교육과 AI 프로젝트를 함께합니다.</p></div>
<div class="biz"><h3>함께한 기업·기관</h3><div class="chips">${B.orgs.map(o => `<span>${esc(o)}</span>`).join('')}</div>
<h3 style="margin-top:18px">주요 분야</h3><div class="chips">${B.fields.map(o => `<span>${esc(o)}</span>`).join('')}</div>
<p style="margin-top:16px">${esc(B.desc)}</p>
<div class="ct"><div class="ctt">강연·프로젝트 문의</div>
<a class="ctr" href="tel:01099732113"><span class="ci">📞</span><span class="cv"><small>전화</small>010-9973-2113</span><span class="ca">전화하기</span></a>
<div class="ctr" onclick="copyText('leejinkyu0612@naver.com','이메일 주소가 복사되었습니다')"><span class="ci">✉️</span><span class="cv"><small>이메일</small>leejinkyu0612@naver.com</span><span class="ca">복사</span></div></div><a class="btn ghost" href="${esc(B.moreUrl)}" target="_blank" rel="noopener">${esc(B.moreLabel)}</a></div>
</div>
<footer class="foot"><div class="eyebrow">FOLLOW @HappyAI</div><div class="soc">${cfg.social.map(([n, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`).join('')}</div><div class="copy">© HappyAI · 해피AI</div><div class="upd">강의 가격·평점·수강생 수는 인프런 기준으로 자동 반영됩니다 · 최근 반영 ${updTxt}</div></footer>
</div><div class="toast" id="toast">링크가 복사되었습니다</div>
<script>
const f=n=>n.toLocaleString('ko-KR'),M=${MONTHS},mon=n=>Math.ceil(n/M/10)*10,p2=n=>String(n).padStart(2,'0');
function left(ms){const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4),s=Math.floor(ms%6e4/1e3);return(d?d+'일 ':'')+p2(h)+':'+p2(m)+':'+p2(s)}
function expire(p){const r=+p.dataset.reg;p.removeAttribute('data-end');const l=p.querySelector('.rate');l&&l.remove();p.querySelector('.mline b').textContent=f(mon(r))+'원';p.querySelector('.sub').innerHTML=M+'개월 할부 · 총 '+f(r)+'원'}
function tick(){const now=Date.now();
const bar=document.getElementById('bar');if(bar&&bar.dataset.end){const ms=Date.parse(bar.dataset.end)-now;if(ms>0)document.getElementById('cd').textContent=left(ms);else bar.style.display='none'}
document.querySelectorAll('.mp[data-end]').forEach(p=>{if(Date.parse(p.dataset.end)<=now)expire(p)});
document.querySelectorAll('.ebird[data-end]').forEach(e=>{const ms=Date.parse(e.dataset.end)-now;if(ms>0)e.querySelector('.cdx').textContent=left(ms);else e.remove()});
document.querySelectorAll('.free.sale[data-end],.ribbon.sr[data-end]').forEach(e=>{if(Date.parse(e.dataset.end)<=now)e.remove()});
document.querySelectorAll('.ncta[data-end]').forEach(e=>{if(Date.parse(e.dataset.end)<=now){e.removeAttribute('data-end');e.textContent='강의 보러가기 →'}});}
tick();setInterval(tick,1000);
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('.pane').forEach(p=>p.classList.toggle('on',p.id===b.dataset.t))});
function copyText(v,msg){const done=()=>{const t=document.getElementById('toast');t.textContent=msg;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),1600)};if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(v).then(done,()=>{prompt('복사해서 사용하세요',v)})}else{const a=document.createElement('textarea');a.value=v;document.body.appendChild(a);a.select();try{document.execCommand('copy');done()}catch(e){prompt('복사해서 사용하세요',v)}a.remove()}}
function copyLink(){copyText(location.href,'링크가 복사되었습니다')}
</script></body></html>
`;
fs.writeFileSync(P('index.html'), html);
log('index.html written', html.length, 'chars; new:', newIds.join(','), 'discounts:', discs.map(c => c.id + ':' + activeDisc(c).rate).join(','));
