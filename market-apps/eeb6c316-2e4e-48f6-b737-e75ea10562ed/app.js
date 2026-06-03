const BUILD_ID = 'vb-mpyaxk4g-3b5b50';
const PROMPT = '城市天气屏 - 按空格切换天气';

const weatherTypes = ['sunny','cloudy','rainy','snowy','haily','night'];
let currentWeatherIndex = 0;

const skyEl = document.getElementById('sky');
const moonEl = document.getElementById('moon');
const rainLayer = document.getElementById('rain-layer');
const snowLayer = document.getElementById('snow-layer');
const hailLayer = document.getElementById('hail-layer');
const clouds = document.getElementById('clouds');
const weatherLabel = document.getElementById('weather-label');
const cityNameEl = document.getElementById('city-name');
const tempDisplay = document.getElementById('temp-display');
const timeDisplay = document.getElementById('time-display');
const deviceName = document.getElementById('device-name');

const weatherNames = {
  sunny: '晴天',
  cloudy: '多云',
  rainy: '下雨',
  snowy: '下雪',
  haily: '冰雹',
  night: '夜晚'
};

const skyColors = {
  sunny: 'linear-gradient(180deg,#4A90D9 0%,#87CEEB 50%,#B0E0E6 100%)',
  cloudy: 'linear-gradient(180deg,#9E9E9E 0%,#BDBDBD 40%,#D3D3D3 100%)',
  rainy: 'linear-gradient(180deg,#616161 0%,#757575 40%,#9E9E9E 100%)',
  snowy: 'linear-gradient(180deg,#B0BEC5 0%,#CFD8DC 40%,#ECEFF1 100%)',
  haily: 'linear-gradient(180deg,#546E7A 0%,#78909C 40%,#90A4AE 100%)',
  night: 'linear-gradient(180deg,#0D0D2B 0%,#1A1A3E 40%,#2D2D5E 100%)'
};

function setWeather(index) {
  const type = weatherTypes[index];
  currentWeatherIndex = index;
  
  skyEl.style.background = skyColors[type];
  
  moonEl.classList.toggle('hidden', type !== 'night');
  rainLayer.classList.toggle('hidden', type !== 'rainy');
  snowLayer.classList.toggle('hidden', type !== 'snowy');
  hailLayer.classList.toggle('hidden', type !== 'haily');
  
  clouds.style.opacity = (type === 'sunny' || type === 'night') ? '0.3' : '0.9';
  
  weatherLabel.textContent = weatherNames[type];
  
  let temp = '--';
  switch(type) {
    case 'sunny': temp = '28'; break;
    case 'cloudy': temp = '22'; break;
    case 'rainy': temp = '15'; break;
    case 'snowy': temp = '-2'; break;
    case 'haily': temp = '5'; break;
    case 'night': temp = '18'; break;
  }
  tempDisplay.textContent = temp + '°C';
}

function nextWeather() {
  const next = (currentWeatherIndex + 1) % weatherTypes.length;
  setWeather(next);
}

function updateTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2,'0');
  const m = String(now.getMinutes()).padStart(2,'0');
  timeDisplay.textContent = h + ':' + m;
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.hostname) cityNameEl.textContent = data.hostname;
    if (data.time) timeDisplay.textContent = data.time;
    if (data.model) deviceName.textContent = data.model;
  } catch(e) {
    cityNameEl.textContent = '本地模式';
  }
}

async function fetchHardwareResult() {
  try {
    const res = await fetch('./hardware-result.json');
    const data = await res.json();
    if (data && data.build_id) {
      console.log('Hardware build:', data.build_id);
    }
  } catch(e) {
    // silent
  }
}

window.VibeBoardHardware = {
  getStatus: async function() {
    try {
      const res = await fetch('/api/status');
      return await res.json();
    } catch(e) {
      return { error: 'unavailable' };
    }
  },
  getProgramResult: async function() {
    try {
      const res = await fetch('./hardware-result.json');
      return await res.json();
    } catch(e) {
      return { error: 'unavailable' };
    }
  },
  getSnapshot: function() {
    return {
      weather: weatherTypes[currentWeatherIndex],
      label: weatherLabel.textContent,
      temp: tempDisplay.textContent,
      time: timeDisplay.textContent
    };
  }
};

document.addEventListener('keydown', function(e) {
  if (e.key === ' ' || e.key === 'Space') {
    e.preventDefault();
    nextWeather();
  }
});

setWeather(1);
updateTime();
setInterval(updateTime, 30000);
fetchStatus();
fetchHardwareResult();
setInterval(fetchStatus, 60000);