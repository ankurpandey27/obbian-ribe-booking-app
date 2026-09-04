/**
 * Weather provider interface. Stubbed for launch — no hard external
 * dependency. Production implementations call a weather API; the stub
 * returns neutral conditions unless overridden via config/Redis.
 */
export interface WeatherCondition {
  condition: 'clear' | 'rain' | 'storm' | 'fog';
  multiplier: number;
}

export interface WeatherProvider {
  getCondition(lat: number, lon: number): WeatherCondition;
}

/**
 * Stub weather provider. Returns neutral (multiplier 1.0) unless a test
 * override is set in Redis (key: weather:override:{lat}:{lon}).
 */
export class StubWeatherProvider implements WeatherProvider {
  getCondition(_lat: number, _lon: number): WeatherCondition {
    // In production, call a weather API here. For now, return neutral.
    return { condition: 'clear', multiplier: 1.0 };
  }
}
