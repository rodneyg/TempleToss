# Changelog

## 2026-11-23

- Hide the leaderboard during runs on compact touch screens to keep the playfield clear. You can still see it in the menu and on the results screen. [PR #29](https://github.com/rodneyg/TempleToss/pull/29)
- Keep clouds, stars, and ground still in menus and on the results screen. These effects also stay still during a run when your device is set to reduce motion. [PR #28](https://github.com/rodneyg/TempleToss/pull/28)
- Move keyboard focus to the active screen when you start, finish, replay, or return to the menu. Space on the focused Toss button tosses without jumping. [PR #27](https://github.com/rodneyg/TempleToss/pull/27)
- Start and play even when the browser blocks storage. Scores, audio settings, and your player name stay available while the page is open. [PR #26](https://github.com/rodneyg/TempleToss/pull/26)

## 2026-11-21

- Keep the game-over screen, score entry, and replay usable if local storage rejects a personal best or leaderboard write. The affected scores stay available until the page reloads or closes. [PR #24](https://github.com/rodneyg/TempleToss/pull/24)
- Make Jump, Toss, and menu buttons easier to read, and group the game screens in a named landmark for screen readers. [PR #23](https://github.com/rodneyg/TempleToss/pull/23)
- Show the game while web fonts load and make the music and sound effects buttons keyboard-accessible. [PR #10](https://github.com/rodneyg/TempleToss/pull/10)
- Add link previews, a favicon, and home screen icons. [PR #6](https://github.com/rodneyg/TempleToss/pull/6)
- Keep the loading title on one line on small phones. [PR #21](https://github.com/rodneyg/TempleToss/pull/21)

## 2026-11-20

- Play a full run on a phone in portrait or landscape. Tap Jump or Toss, hold Jump to go higher, and hold the left or right arrow to steer in the air. After a run, use the game-over screen to save a score that makes the leaderboard, play again, or return to the menu. [PR #4](https://github.com/rodneyg/TempleToss/pull/4)
- Start music and sound effects on the first interaction. Pause the run and audio while the tab is hidden. [PR #7](https://github.com/rodneyg/TempleToss/pull/7)
- Show the run score and save a new personal best on the results screen. [PR #12](https://github.com/rodneyg/TempleToss/pull/12)
- Count multiple target hits and cleared obstacles that happen in the same frame. [PR #20](https://github.com/rodneyg/TempleToss/pull/20)
- Start the game even when saved sound settings or leaderboard data are malformed. [PR #19](https://github.com/rodneyg/TempleToss/pull/19)
- Keep the score and leaderboard clear of phone cutouts and keep targets and power-ups visible when the screen rotates. [PR #11](https://github.com/rodneyg/TempleToss/pull/11)
- Toss with one finger while holding a steering arrow with another, and wrap long leaderboard names on narrow phones. [PR #18](https://github.com/rodneyg/TempleToss/pull/18)
