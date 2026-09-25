import { tool } from '@openrouter/agent'
import { z } from 'zod'

/**
 * Open-Meteo needs no API key, and its geocoding endpoint turns "Berlin" into
 * the coordinates the forecast endpoint wants — so one tool covers both hops
 * and the model never has to know about latitude.
 */
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'

/** The WMO weather codes Open-Meteo returns, spelled out for the model. */
const CONDITIONS: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  80: 'rain showers',
  95: 'thunderstorm',
  99: 'thunderstorm with hail',
}

export const getWeather = tool({
  name: 'get_weather',
  description:
    'Get the current weather for a place. Accepts a city or place name, ' +
    'optionally with region or country ("Berlin", "Portland, Oregon").',
  inputSchema: z.object({
    location: z.string().describe('City or place name, e.g. "Berlin"'),
  }),
  execute: async ({ location }) => {
    console.log('getWeather ...', location)
    const place = await geocode(location)
    // Returned rather than thrown: the model can relay "I could not find that
    // place" to the user, whereas a throw would abort the whole run.
    if (place === undefined) return { error: `Could not find a place named "${location}".` }

    const current = await currentWeather(place.latitude, place.longitude)
    return {
      location: [place.name, place.admin1, place.country]
        .filter((part) => part !== undefined && part !== '')
        .join(', '),
      temperature_c: current.temperature_2m,
      relative_humidity_pct: current.relative_humidity_2m,
      wind_speed_kmh: current.wind_speed_10m,
      conditions: CONDITIONS[current.weather_code] ?? `unknown (WMO ${current.weather_code})`,
    }
  },
})

type Place = {
  name: string
  latitude: number
  longitude: number
  admin1?: string
  country?: string
}

async function geocode(location: string): Promise<Place | undefined> {
  const url = new URL(GEOCODE)
  url.searchParams.set('name', location)
  url.searchParams.set('count', '1')

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding failed (HTTP ${res.status} ${res.statusText})`)

  const body = (await res.json()) as { results?: Place[] }
  return body.results?.[0]
}

type Current = {
  temperature_2m: number
  relative_humidity_2m: number
  wind_speed_10m: number
  weather_code: number
}

async function currentWeather(latitude: number, longitude: number): Promise<Current> {
  const url = new URL(FORECAST)
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code',
  )

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Forecast failed (HTTP ${res.status} ${res.statusText})`)

  const body = (await res.json()) as { current?: Current }
  if (body.current === undefined) throw new Error('Open-Meteo returned no current weather')
  return body.current
}
