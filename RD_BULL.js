// SyntheticSignalsRDBULL.js
import WebSocket from "ws";
import { EMA, MACD, StochasticRSI } from "technicalindicators";
import chalk from "chalk";
import notifier from "node-notifier";
import dayjs from "dayjs";

// --- CONFIG ---
const SYMBOLS = ["RDBULL"];
const TREND_WINDOW = 30;
const STATUS_INTERVAL = 5000; // table refresh every 5s
const TRADE_CHECK_INTERVAL = 1000; // update Time Elapsed every 1s
const TRADE_CLEAR_MS = 5 * 60 * 1000; // clear after 5 min

// --- STATE ---
const managers = {};
const activeEntries = [];
SYMBOLS.forEach(s => managers[s] = { closes: [], latestPrice: 0 });

// --- HELPERS ---
function linearRegression(points) {
    const n = points.length;
    const xMean = (n-1)/2;
    const yMean = points.reduce((a,b)=>a+b,0)/n;
    let num=0, den=0;
    points.forEach((y,i)=>{num+=(i-xMean)*(y-yMean);den+=(i-xMean)**2});
    return {slope: num/den};
}

function chooseDuration(slope, macdHist) {
    if(slope>0.02 && macdHist>0.01) return 10;
    if(slope>0.01 && macdHist>0.005) return 5;
    return 1;
}

function alertSignal(entry) {
    const {symbol,status,duration,openTime} = entry;
    const msg = `${symbol} ${status} | Duration: ${duration}-min | Open: ${openTime.format('HH:mm:ss')}`;
    notifier.notify({title:`${symbol} Trade Alert`, message: msg, sound:true});
}

// --- WEBSOCKET ---
const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

ws.on('open',()=>{
    console.log(chalk.green("✅ Connected to Deriv"));
    SYMBOLS.forEach(symbol => ws.send(JSON.stringify({ticks: symbol, subscribe:1})));
});

ws.on('message', raw=>{
    const data = JSON.parse(raw.toString());
    if(!data.tick) return;
    const symbol = data.tick.symbol;
    const price = Number(data.tick.quote);
    const mgr = managers[symbol];
    mgr.latestPrice = price;
    mgr.closes.push(price);
    if(mgr.closes.length>100) mgr.closes.shift();
    const closes = mgr.closes;
    if(closes.length<50) return;

    // --- Indicators ---
    const e25 = EMA.calculate({period:25, values:closes}).at(-1);
    const e50 = EMA.calculate({period:50, values:closes}).at(-1);
    const e100 = EMA.calculate({period:100, values:closes}).at(-1);
    const emaAligned = e25>e50 && e50>e100 && closes.at(-1)>e100;

    const m = MACD.calculate({values:closes, fastPeriod:12, slowPeriod:26, signalPeriod:9});
    const lastMACD = m.at(-1);
    const macdUp = lastMACD?.MACD > lastMACD?.signal && lastMACD?.histogram>0;

    const st = StochasticRSI.calculate({values:closes, rsiPeriod:14, stochasticPeriod:14, kPeriod:3, dPeriod:3});
    const lastSt = st.at(-1);
    const stochUp = lastSt?.k>50 && lastSt?.d>50 && lastSt.k>lastSt.d;

    const recent = closes.slice(-TREND_WINDOW);
    const {slope} = linearRegression(recent);

    const emaDiff = Math.abs(e25-e50);
    const macdHist = lastMACD?.histogram || 0;
    const noisy = emaDiff<0.01 && Math.abs(macdHist)<0.001;

    const now = dayjs();

    if(noisy){
        activeEntries.push({symbol,status:chalk.yellow("⚠️ Noisy"),duration:1,openTime:now});
        return;
    }

    if(emaAligned && macdUp && stochUp && slope>0){
        const duration = chooseDuration(slope, macdHist);
        const status = chalk.green("↑ UPTREND");
        activeEntries.push({symbol,status,duration,openTime:now});
        alertSignal({symbol,status,duration,openTime:now});
    }
});

// --- STATUS TABLE ---
setInterval(()=>{
    console.clear();
    console.log(chalk.blue("📊 CapitalSignals RDBULL — Synthetics Overview\n"));
    console.log(`SYMBOL      PRICE      1H     30M     15M`);
    console.log('-----------------------------------------');
    SYMBOLS.forEach(symbol=>{
        const mgr = managers[symbol];
        const price = mgr.latestPrice.toFixed(2) || "N/A";
        console.log(`${symbol.padEnd(10)} ${price.padEnd(10)} ${chalk.green('↑')}      ${chalk.green('↑')}      ${chalk.green('↑')}`);
    });

    console.log('\n📈 Active Entries RDBULL — Trade Alerts\n');
    console.log(`SYNTHETIC   STATUS       DURATION   OPEN TIME   TIME ELAPSED`);
    console.log('----------------------------------------------------------');
    const liveNow = dayjs();
    activeEntries.forEach((entry,i)=>{
        const elapsedSec = liveNow.diff(entry.openTime,'second');
        const minutes = Math.floor(elapsedSec/60);
        const seconds = elapsedSec%60;
        const timeStr = `${minutes}:${seconds.toString().padStart(2,'0')}`;
        console.log(`${entry.symbol.padEnd(10)} ${entry.status.padEnd(12)} ${entry.duration}-min     ${entry.openTime.format('HH:mm:ss')}     ${timeStr}`);
    });
}, STATUS_INTERVAL);

// --- CLEAR ENTRIES AFTER 5 MIN ---
setInterval(()=>{
    const now = dayjs();
    for(let i=activeEntries.length-1;i>=0;i--){
        const entry = activeEntries[i];
        if(now.diff(entry.openTime,'minute')>=5){
            activeEntries.splice(i,1);
        }
    }
}, TRADE_CHECK_INTERVAL);
