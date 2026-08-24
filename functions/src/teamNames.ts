// functions/src/teamNames.ts
//
// Server-side copy of the friendly Beer Game team names + picker. MIRRORS
// src/logic/teamNames.ts (the frontend list the normal host-lobby flow uses) — functions
// cannot import from the frontend src/, so the list is duplicated here on purpose. Keep the
// two in step; if they drift, the classroom teams simply draw from a slightly different pool.
//
// Used by classroom.ts so a matched group provisioned into the Beer Game gets a real team
// name ("Hoppy Campers") instead of the raw matcher group UUID.

import * as crypto from "crypto";

export const BEER_TEAM_NAMES: readonly string[] = [
  "The Harry Porters", "Foamy Mountain", "Yeast Mode", "Malt Mavericks", "Barley & Chill",
  "Lager Legends", "Pint of View", "Brewed Awakening", "Hopportunity Knocks", "Foam Sweet Foam",
  "Buzzed Barrels", "Golden Suds", "Tipsy Taproom", "Frothy Fellows", "Bitter Bliss",
  "Sip Happens", "Stout Scouts", "Draft Punks", "Hopsicle Stand", "The Empire Strikes Bock",
  "Barrel Roll", "Beauty and the Yeast", "Keg Against the Machine", "Hoppy Campers", "Stein Time",
  "Don’t Worry, Be Hoppy", "Twist and Stout", "Keg & Kettle", "Hops on the Rocks", "The Brews Brothers",
  "Cheerful Cheers", "Draft Draftsmen", "Hop Star Heroes", "Bubbly Barley", "Laughing Lager",
  "Giggling Grain", "Bad News Beers", "Just-In-Stein", "Mischief Malt", "The Bull-sip Effect",
  "Foam & Fortune", "Stout of Control", "Gulp Fiction", "Hoppy Ending", "Obi-Wan Can-nobi",
  "Tipsy Tankards", "To Beer or Not To Beer", "Dunkel & Dragons", "Grain Train", "Barley Making It",
  "Barrel Brothers", "Game of Foams", "Foamy Forecast", "Hop-portunity Knocks", "Brewed & Confused",
  "Yeast of Eden", "Golden Growlers", "Yeast of Burden", "Hop Goblins", "Suds Squadron",
  "Lager Than Life", "Tropical Taps", "Lazy Lagerheads", "Pint of No Return", "Grainstorm",
  "Foam Frontiers", "Ferment to Be", "Hoppy Harbor", "Bubble & Barley", "Malty Mission",
  "Hops & Dreams", "KegQuest", "Draft Dynasty", "Barrel Bandits", "Cheery Chela",
  "Stein Society", "Groovy Growlers", "Lofty Lager", "Brewed Banter", "Taproom Titans",
  "Hoppy Highway", "Foamy Fellowship", "Buzzed Brigade", "Brew Voyage", "Ale Force One",
  "Suds Station", "Hop Springs Eternal", "Stout & About", "Flight Club", "Malt Mischief",
  "Hop & Seek", "Foam Horizon", "Yeast Feast", "Barrel Bliss", "Tap Dance",
  "Hop Shelf Heroes", "Suds Circus", "Barley Party", "Foamy Galaxy", "Brewtiful Day",
];

/**
 * Pick a friendly team name not already in `used` (mutated to include the choice). When the
 * pool is exhausted, falls back to a numbered variant, mirroring the frontend's pickTeamName.
 * `index` seeds only the fallback base, so callers pass the team's position in the batch.
 */
export function pickTeamName(index: number, used: Set<string>): string {
  const available = BEER_TEAM_NAMES.filter((name) => !used.has(name));
  let chosen: string;
  if (available.length > 0) {
    chosen = available[crypto.randomInt(available.length)];
  } else {
    const base = BEER_TEAM_NAMES[index % BEER_TEAM_NAMES.length];
    let suffix = 2;
    chosen = `${base} ${suffix}`;
    while (used.has(chosen)) {
      suffix += 1;
      chosen = `${base} ${suffix}`;
    }
  }
  used.add(chosen);
  return chosen;
}
