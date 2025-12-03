# The Beer Game

This is an open-source implementation of the classic beer game by Jay Forrester. The beer game is an excellent introduction to supply chain management and illustrates the bullwhip effect to students.

## Version Update

We ran the game with two classes of 50 students at Koc University in Istanbul. It ran well, but we immediately spotted some features that would improve the experience.

The most recent version includes the following changes:

* The game now automatically shows the ending screen for players who have finished all rounds of the game
* If players enter a negative order, the order is replace with 0
* If players enter an order above 50, they get a warning pop-up and are allowed to revise their order. Sometimes, players accidentally double-tap a key.
* The ending graphs of orders have a standardized y-scale that maxes out at 25
* The host can replace players with robo-players in the host screen; this is necessary when students sign in twice (creating a ghost in the system), or when students leave early.
* Players who join late (after a session starts) can still join by replacing robo players
* The host can tweak some game parameters in the upfront screen
* The host can download a list of players after the session is complete
* Added some AI generated graphics to the sign up and waiting screens

## Hosting

I host this version of the game [here](https://go.wisc.edu/394776). Hosting is free to a certain point - about 200 people can play the beer game a day, and I won't be charged. But I will incur some small costs if usage goes beyond. I will pay for these costs on my own, but if you become a heavy user in your classes, I would appreciate a cost share. Message me at esiemsen@wisc.edu if you are using the product a lot. If costs become too high, I may turn off the app. I added a guide of how to setup hosting yourself, for free, [here](https://github.com/siemsene/beergame/blob/main/Howtohost.md).

## Other Beer Games

You can buy the original beer game materials from the [System Dynamics Society](https://systemdynamics.org/product/supply-chain-game-the-beer-game-complete-game-set/). There are other free online versions of the beer game available, such as those at [Transentis](https://beergame.transentis.com/) or [MA Systems](https://beergame.masystem.se/). There are also paid versions at [HB Online](https://hbsp.harvard.edu/product/7908-HTM-ENG), [Zensimu](https://zensimu.com/p/beer-game/), and [FathomD](https://www.fathomd.com/bdg).

## License

This version of the beer game is open source and has a [Creative Commons license](https://creativecommons.org/licenses/by-sa/4.0/). You can use it for free, and you can modify the code as you see fit; but anything you build on this code has to fall under the same license.

## How to Start a Session

I am currently hosting a version of this code [here](https://the-beer-game-37777398-4d5fb.web.app/). You can use it for teaching if you like. The backend is Firebase. I am using a 'no-cost' Spark plan that caps at 20K writes and 50K reads per day. This should be enough for classroom use, but if you want to make sure, set up your own [Firebase](https://console.firebase.google.com/) account. The product is easy to use and works incredibly well. Thanks, Google!

To host a game, you first need to log in as a host; it will ask you for a password, which is 'Sesame'. I know - not very secure, but enough for now. You can then create a new session with a Game ID. You can share this ID with students, who can then log in with this game ID and a Name. This can be any name - but they should remember it, since if they get disconnected from the game, they can always reconnect with the Game ID and their name as long as the session is still running.

You can test this out yourself with multiple browser tabs.

You can monitor the lobby as the host and remove players if you want to. When all players have registered, you can start the game. The app will automatically assign students to teams and roles (at random) and fill teams with robo players (called Beer-GPT) if the number of students in the lobby is not divisible by 4.

## Game Rules

The game uses the standard beer game demand and cost data. Shipping lead time is 2, but order lead time is only 1 - downstream partners will see the order placed in the prior period.

The game lasts 40 periods, but can be ended at any time in the host's view. Upon completion, the host will see a leaderboard and graphs for all supply chains, showing their orders. Each supply chain will see its own total costs, as well as a graph of all orders in the supply chain.

Beer-GPT players will always place an order based on the demand they see, +/-1.

## Feedback

Provide any general feedback about the game at [this Google doc](https://docs.google.com/document/d/1HgR_ZYDW3X7Hj-f2chM5Yn7ay8UJtEKwUhdIEUQ4YoE/edit?usp=sharing).
