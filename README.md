# Temple Toss

Temple Toss is an exciting HTML5 side-scrolling adventure game where you control a character running through an ancient temple. Your goal is to avoid obstacles, collect power-ups, and hit targets to score as many points as possible. The game is designed to be played directly in a web browser with no additional software required.

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [How to Play](#how-to-play)
- [Setup](#setup)
- [Development](#development)
- [Changelog](CHANGELOG.md)
- [Future Plans](#future-plans)
- [Credits](#credits)
- [Feedback and Issues](#feedback-and-issues)

## Overview

In *Temple Toss*, you navigate through a mystical temple filled with obstacles, power-ups, and targets. The game combines fast-paced running, jumping, and tossing mechanics to create an engaging experience. As you progress, you can collect power-ups to activate special abilities like the **Super Jump**, which allows you to reach higher targets and avoid obstacles more effectively.

The game features a **beautiful temple-themed background**, complete with stars, clouds, and a dynamic ground pattern.

## Key Features

### Gameplay Mechanics:
- **Jump** to avoid obstacles and collect power-ups.
- **Toss** projectiles to hit targets and score points.
- **Super Jump**: Activated by collecting yellow orbs, this temporary power-up allows you to jump higher and reach otherwise inaccessible targets.

### Audio:
- Music and sound effects have separate toggles. Both default to on. Audio files load from external sites, so the game may be silent if those files are unavailable. Your browser may also block music when the page first opens.

### Visuals:
- **Temple-themed background** with stars, clouds, and a moving ground pattern.
- **Player character** with a dynamic shadow effect.
- **Distinct visual designs** for obstacles, power-ups, and targets.

### Scoring:
- Earn points by clearing obstacles and hitting targets.
- Bonus points for hitting **high targets** and during **super jump mode**.

### Leaderboard:
- A **local leaderboard** that stores the **top 5 scores** with player names.

### Mobile Compatibility:
- Phones show Jump, Toss, and left and right arrow buttons in portrait and landscape.

## How to Play

### Start the Game:
Select **Start Game** to begin. After a run, you can select **Play Again** or **Main Menu**. If you earn a spot on the leaderboard, the game reuses the name you entered earlier in the session. If it asks for a name, enter one and select **Save Score**, **Play Again**, or **Main Menu** to save the score. A blank name is saved as **Player**.

### Controls:
- **Jump**. Press Space, W, or the up arrow, or use the Jump button. Hold to jump higher.
- **Toss**. Press T or use the Toss button.
- **Move left or right in the air**. Hold A or D, the left or right arrow key, or an on-screen arrow on a touch device.
- **Audio Toggles**:  
  - Click the **speaker icon** (top-right) to mute/unmute background music.  
  - Click the **headphones icon** to mute/unmute sound effects.

### Gameplay:
- Avoid **triangular obstacles** by jumping over them.
- Collect **yellow orbs** to activate **super jump mode**, which allows for higher jumps.
- Hit **bullseye targets** with your body or projectiles to score points.
- The game **ends when you collide** with an obstacle.

### Scoring:
- Points are awarded for:
  - Avoiding obstacles (**+5**)
  - Hitting targets (**+10** or **+20** for high targets)
- In **super jump mode**, points for hitting targets are **doubled**.

## Setup

- **Requirements**: A modern web browser (e.g., **Chrome, Firefox, Edge**).
- **Installation**: No installation required. Simply **open the `index.html` file** in your browser.
- **Playing the Game**: Click **"START GAME"** to begin. Use the controls to navigate through the temple and score points.

## Development

### Technology Stack:
- Developed using **HTML5, CSS, and JavaScript**.
- Utilizes the **requestAnimationFrame API** for smooth animations.

### Browser tests:

Run `npm ci` and `npx playwright install chromium`, then run `npm run lint` and `npm test`. The tests cover touch play in both orientations and desktop keyboard and mouse play.

### Current State:
- The game includes **core mechanics** such as jumping, tossing, obstacle avoidance, power-up collection, and target hitting.
- **Visual and audio elements** are implemented, with **toggle options** for user preference.
- A **local leaderboard** tracks the top 5 scores.

## Future Plans

As the author, I have **ambitious plans** to elevate *Temple Toss* into a world-class game. Here are some features planned for future updates:

### Gameplay Enhancements:
- Add new **power-ups** (e.g., **speed boosts, shields**) and **obstacles** for variety.
- Introduce **levels with increasing difficulty** and unique themes.

### Competitive Features:
- Integrate a **worldwide live leaderboard** using a backend service (e.g., **Firebase**).
- Add **daily challenges and achievements** for replayability.

### Visual and Audio Polish:
- Enhance **player animations** (e.g., running, tossing).
- Add **particle effects** when players hit targets.
- Include **thematic sound effects** and voiceovers for key events.

### Social Sharing:
- Implement **social media sharing** for scores and achievements (Twitter/X, Facebook, Instagram).
- Add **"Challenge a Friend"** feature to encourage competition.
- Include **quick share links** for bragging rights.

### Monetization:
- Introduce optional **in-game purchases** (e.g., **cosmetics, power-ups**).
- Add **rewarded video ads** for extra lives or currency.

## Credits

- **Game Design and Development**: *Rodney Gainous Jr.*
- **Music**: *"Adventure" by Bensound*
- **Sound Effects**: *SoundJay*
- **Icons**: *Font Awesome*

## Feedback and Issues

If you encounter any **bugs** or have **suggestions for improvements**, I’d love to hear from you! Please:

- [Open an issue on GitHub](https://github.com/rodneyg/TempleToss/issues).
- Contact me directly at **[rodney.gainous@gmail.com](mailto:rodney.gainous@gmail.com)**.
