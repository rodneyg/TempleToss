# Temple Toss

Temple Toss is an exciting HTML5 side-scrolling adventure game where you control a character running through an ancient temple. Your goal is to avoid obstacles, collect power-ups, and hit targets to score as many points as possible. The game is designed to be played directly in a web browser with no additional software required.

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [How to Play](#how-to-play)
- [Setup](#setup)
- [Development](#development)
- [Future Plans](#future-plans)
- [Credits](#credits)
- [Feedback and Issues](#feedback-and-issues)

## Overview

In *Temple Toss*, you navigate through a mystical temple filled with obstacles, power-ups, and targets. The game combines fast-paced running, jumping, and tossing mechanics to create an engaging experience. As you progress, you can collect power-ups to activate special abilities like the **Super Jump**, which allows you to reach higher targets and avoid obstacles more effectively.

The game features a **beautiful temple-themed background**, complete with stars, clouds, and a dynamic ground pattern. It also includes immersive audio elements, such as background music and sound effects, which enhance the overall gameplay experience.

## Key Features

### Gameplay Mechanics:
- **Jump** to avoid obstacles and collect power-ups.
- **Toss** projectiles to hit targets and score points.
- **Super Jump**: Activated by collecting yellow orbs, this temporary power-up allows you to jump higher and reach otherwise inaccessible targets.

### Controls:
- **Jump**: Press `Spacebar`, `W`, or click the Jump button (left side).
- **Toss**: Press `T` or click the Toss button (right side).
- **Move Left/Right**: Use `A/D` or arrow keys for air control during jumps.

### Audio:
- Toggleable **background music** (default: on).
- Toggleable **sound effects** for actions like jumping, tossing, collecting power-ups, hitting targets, and colliding with obstacles.

### Visuals:
- **Temple-themed background** with stars, clouds, and a moving ground pattern.
- **Player character** with a dynamic shadow effect.
- **Distinct visual designs** for obstacles, power-ups, and targets.

### Scoring:
- Earn points by avoiding obstacles, collecting power-ups, and hitting targets.
- Bonus points for hitting **high targets** and during **super jump mode**.

### Leaderboard:
- A **local leaderboard** that stores the **top 5 scores** with player names.

### Mobile Compatibility:
- The game is **responsive** and can be played on mobile devices, though touch controls are not yet implemented.

## How to Play

### Start the Game:
Click the **"START GAME"** button to begin.

### Controls:
- **Jump**: Use `Spacebar`, `W`, or the Jump button to leap over obstacles and collect power-ups.
- **Toss**: Use `T` or the Toss button to throw projectiles at targets.
- **Move Left/Right**: Use `A/D` or arrow keys to adjust your position mid-air during jumps.
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
  - Collecting power-ups
  - Hitting targets (**+10** or **+20** for high targets)
- In **super jump mode**, points for hitting targets are **doubled**.

## Setup

- **Requirements**: A modern web browser (e.g., **Chrome, Firefox, Edge**).
- **Installation**: No installation required. Simply **open the `temple-toss.html` file** in your browser.
- **Playing the Game**: Click **"START GAME"** to begin. Use the controls to navigate through the temple and score points.

## Development

### Technology Stack:
- Developed using **HTML5, CSS, and JavaScript**.
- Utilizes the **requestAnimationFrame API** for smooth animations.
- Audio is managed via the **Web Audio API**.

### Current State:
- The game includes **core mechanics** such as jumping, tossing, obstacle avoidance, power-up collection, and target hitting.
- **Visual and audio elements** are implemented, with **toggle options** for user preference.
- A **local leaderboard** tracks the top 5 scores.

## Future Plans

As the author, I have **ambitious plans** to elevate *Temple Toss* into a world-class game. Here are some features planned for future updates:

### Mobile Compatibility:
- Implement **touch controls** for jumping and tossing on mobile devices.
- Optimize **UI elements** for smaller screens.

### Gameplay Enhancements:
- Add new **power-ups** (e.g., **speed boosts, shields**) and **obstacles** for variety.
- Introduce **levels with increasing difficulty** and unique themes.

### Competitive Features:
- Integrate a **worldwide live leaderboard** using a backend service (e.g., **Firebase**).
- Add **daily challenges and achievements** for replayability.

### Visual and Audio Polish:
- Enhance **player animations** (e.g., running, tossing).
- Add **particle effects** for actions like hitting targets or collecting power-ups.
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

- **Open an issue** on the game’s **GitHub repository** (if available).
- Contact me directly at **[rodney.gainous@gmail.com](mailto:rodney.gainous@gmail.com)**.

---

This README reflects the **current state** of *Temple Toss* and my **vision for its future**. I hope you **enjoy playing it** as much as I enjoyed creating it!

Feel free to **customize the placeholders** (e.g., `[Your Name]`, `[your-email@example.com]`) with your actual details.

----

# Converting Temple Toss Gameplay to Touch Controls

## Introduction
The goal of this document is to adapt the gameplay of *Temple Toss* from keyboard-based inputs to a fully touch-based experience on **iPhone** and **Android**. This transition must maintain the game’s fluidity, responsiveness, and engagement while ensuring a natural feel for mobile users.

---

## Touch-Based Control Scheme

### **1. Jumping Mechanism**
- **Single Tap** anywhere on the screen to jump.
- **Tap and Hold** increases the jump height slightly, allowing controlled jumps.
- **Super Jump Activation**: When the player collects a yellow orb, a subtle glow appears around the character. A **double tap** triggers the super jump while active.
- **Feedback:** A slight vibration (haptic feedback) should be added when the player jumps to improve engagement.

### **2. Tossing Mechanism**
- **Swipe Up** anywhere on the right half of the screen to toss a projectile.
- **Tossing Feedback:** A quick flick animation should follow the projectile's release, making the motion intuitive.

### **3. Movement & Mid-Air Adjustments**
- **Tilt Control:** Enable optional gyroscope-based tilt controls for adjusting left and right movement in mid-air.
- **Alternative:** Swiping left or right on the left side of the screen can also allow for minor in-air adjustments.

### **4. UI & Button Layout Adjustments**
- The on-screen "JUMP" and "TOSS" buttons should be optional. Default mode should be **gesture-based**, but buttons can be enabled in settings for accessibility.
- Buttons should be **semi-transparent**, appearing only when the user interacts with them to avoid cluttering the screen.

### **5. Audio & Settings Access**
- **Audio Controls:** Place music and sound effect toggles in the **top-right corner**.
- **Pause & Settings:** A small gear icon in the top-left corner pauses the game and allows customization of controls.

---

## Touch-Optimized Game Feel

### **Haptic Feedback & Visual Response**
- **Jump Feedback:** Light vibration on jump.
- **Obstacle Collision:** Stronger vibration when the player collides with an obstacle.
- **Power-Up Collection:** A subtle pulse effect when collecting yellow orbs.
- **Toss Action:** A small shake or recoil when tossing a projectile.

### **Animations & Transitions**
- **Jump Squash-Stretch Animation:** Ensure a bounce effect when the player lands to make movement feel responsive.
- **Swipe-Based Toss:** The projectile should follow a quick trajectory with a slight motion blur.
- **Score & Hit Feedback:** Floating numbers appear where the projectile hits the target.

### **Optimized Performance on Mobile**
- Reduce unnecessary background processes to **maximize frame rates**.
- Ensure touch events are **prioritized over passive listeners** to reduce input lag.
- Use **lazy rendering** for off-screen objects to optimize performance on older devices.

---

## Additional Enhancements for Mobile

### **Adaptive Screen Adjustments**
- The game should automatically **resize UI elements** based on screen size.
- On **tablets**, provide an option for **wider touch zones** for comfortable gameplay.

### **Social Sharing Integration**
- Add quick-share buttons for **Twitter, Instagram, and Facebook** after achieving a high score.
- Enable **"Challenge a Friend"** feature by allowing players to send a challenge link.

### **Cloud Save & Leaderboards**
- Implement Firebase or Game Center integration for **online leaderboards**.
- Allow players to save progress and scores across devices.

---

## Conclusion
With these optimizations, *Temple Toss* will deliver a **seamless, engaging, and intuitive** mobile experience. The touch-based control system must be natural and **fluid**, ensuring that the gameplay remains immersive while optimizing for both iPhone and Android devices.

These changes will **eliminate the need for on-screen buttons** in most cases, relying instead on **gestures and intuitive interactions** that feel like a native mobile experience.

---

**Author:** Rodney Gainous Jr.  
**Contact:** [rodney.gainous@gmail.com](mailto:rodney.gainous@gmail.com)

