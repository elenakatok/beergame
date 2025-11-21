# The Beer Game

This is an open-source implementation of the classic beer game by Jay Forrester. The beer game is an excellent introduction to supply chain management and illustrates the bullwhip effect to students.

## Other Beer Games

You can buy the original beer game materials from the [System Dynamics Society](https://systemdynamics.org/product/supply-chain-game-the-beer-game-complete-game-set/). There are other free online versions of the beer game available, such as those at [Transentis](https://beergame.transentis.com/) or [MA Systems](https://beergame.masystem.se/). There are also paid versions at [HB Online](https://hbsp.harvard.edu/product/7908-HTM-ENG), [Zensimu](https://zensimu.com/p/beer-game/), and [FathomD](https://www.fathomd.com/bdg).

## License

This version of the beer game is open source and has a [Creative Commons license](https://creativecommons.org/licenses/by-sa/4.0/). You can use it for free, and you can modify the code as you see fit; but anything you build on this code has to fall under the same license.

## How to Start a Session

I am currently hosting a version of this code [here](https://the-beer-game-37777398-4d5fb.web.app/). You can use it for teaching if you like. The backend is Firebase. I am using a 'no-cost' Spark plan that caps at 20K writes and 50K reads per day. This should be enough for classroom use, but if you want to make sure, set up your own [Firebase](https://console.firebase.google.com/) account. The product is easy to use and works incredibly well. Thanks, Google!

To host a game, you first need to log in as a host; it will ask you for a password, which is 'Sesame'. I know - not very secure, but enough for now. You can then create a new session with a Game ID. You can share this ID with students, who can then log in with this game ID and a Name. This can be any name - but they should remember it, since if they get disconnected from the game, they can always reconnect with the Game ID and their name as long as the session is still running.

You can test this out yourself with multiple browser tabs.

You can monitor the lobby as the host and remove players if you want to. When all players have registered, you can start the game. The app will automatically assign students to teams and roles (at random) and fill teams with robo players (called Beer-GPT) if the number of students in the lobby is not divisible by 4. 
