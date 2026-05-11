(() => {
  "use strict";

  const SUITS = ["S", "H", "D", "C"];
  const SUIT_SYMBOLS = {
    S: "♠",
    H: "♥",
    D: "♦",
    C: "♣",
  };
  const SUIT_NAMES = {
    S: "Spades",
    H: "Hearts",
    D: "Diamonds",
    C: "Clubs",
  };
  const RANK_LABELS = {
    1: "A",
    11: "J",
    12: "Q",
    13: "K",
  };

  function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
      for (let rank = 1; rank <= 13; rank += 1) {
        deck.push({ suit, rank, faceUp: false });
      }
    }
    return deck;
  }

  function shuffle(deck) {
    const shuffled = deck.slice();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  function newGame(drawMode = 1) {
    const deck = shuffle(createDeck());
    const tableau = Array.from({ length: 7 }, () => []);

    for (let pileIndex = 0; pileIndex < tableau.length; pileIndex += 1) {
      for (let cardIndex = 0; cardIndex <= pileIndex; cardIndex += 1) {
        const card = deck.pop();
        card.faceUp = cardIndex === pileIndex;
        tableau[pileIndex].push(card);
      }
    }

    return {
      drawMode,
      stock: deck,
      waste: [],
      foundations: {
        S: [],
        H: [],
        D: [],
        C: [],
      },
      tableau,
      moves: 0,
      seconds: 0,
      status: "Playing",
      won: false,
    };
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function rankLabel(rank) {
    return RANK_LABELS[rank] || String(rank);
  }

  function cardCode(card) {
    return card ? `${rankLabel(card.rank)}${card.suit}` : null;
  }

  function cardLabel(card) {
    if (!card) return "";
    return `${rankLabel(card.rank)} ${SUIT_NAMES[card.suit]}`;
  }

  function isRedSuit(suit) {
    return suit === "H" || suit === "D";
  }

  function cardColor(card) {
    return isRedSuit(card.suit) ? "red" : "black";
  }

  function topCard(pile) {
    return pile.length > 0 ? pile[pile.length - 1] : null;
  }

  function canMoveRun(cards) {
    if (!cards.length || !cards[0].faceUp) return false;

    for (let index = 1; index < cards.length; index += 1) {
      const previous = cards[index - 1];
      const current = cards[index];
      const isDescending = previous.rank === current.rank + 1;
      const alternates = cardColor(previous) !== cardColor(current);
      if (!current.faceUp || !isDescending || !alternates) {
        return false;
      }
    }

    return true;
  }

  function canPlaceOnTableau(cards, destinationPile) {
    if (!canMoveRun(cards)) return false;

    const movingCard = cards[0];
    const destinationCard = topCard(destinationPile);

    if (!destinationCard) {
      return movingCard.rank === 13;
    }

    return (
      destinationCard.faceUp &&
      destinationCard.rank === movingCard.rank + 1 &&
      cardColor(destinationCard) !== cardColor(movingCard)
    );
  }

  function canPlaceOnFoundation(card, foundationPile) {
    if (!card || !card.faceUp) return false;

    const foundationCard = topCard(foundationPile);
    if (!foundationCard) {
      return card.rank === 1;
    }

    return card.suit === foundationCard.suit && card.rank === foundationCard.rank + 1;
  }

  function foundationSummary(foundations) {
    return SUITS.reduce((summary, suit) => {
      const pile = foundations[suit];
      summary[suit] = {
        count: pile.length,
        top: cardCode(topCard(pile)),
      };
      return summary;
    }, {});
  }

  function isWon(state) {
    return SUITS.every((suit) => state.foundations[suit].length === 13);
  }

  window.SolitaireLogic = {
    SUITS,
    SUIT_SYMBOLS,
    SUIT_NAMES,
    cardCode,
    cardColor,
    cardLabel,
    canMoveRun,
    canPlaceOnFoundation,
    canPlaceOnTableau,
    cloneState,
    foundationSummary,
    isRedSuit,
    isWon,
    newGame,
    rankLabel,
    topCard,
  };
})();
