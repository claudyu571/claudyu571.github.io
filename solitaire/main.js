(() => {
  "use strict";

  const Logic = window.SolitaireLogic;
  const MODE_KEY = "hapics-solitaire-draw-mode";
  const BEST_KEY_PREFIX = "hapics-solitaire-best";
  const MAX_HISTORY = 80;

  const els = {
    autoBtn: document.getElementById("auto-btn"),
    bestScore: document.getElementById("best-score"),
    board: document.getElementById("board"),
    closeWinBtn: document.getElementById("close-win-btn"),
    drawBtn: document.getElementById("draw-btn"),
    drawOneBtn: document.getElementById("draw-one-btn"),
    drawThreeBtn: document.getElementById("draw-three-btn"),
    foundationRow: document.getElementById("foundation-row"),
    foundationStatus: document.getElementById("foundation-status"),
    hintBtn: document.getElementById("hint-btn"),
    message: document.getElementById("message"),
    modeEyebrow: document.getElementById("mode-eyebrow"),
    moves: document.getElementById("moves"),
    newGameBtn: document.getElementById("new-game-btn"),
    playAgainBtn: document.getElementById("play-again-btn"),
    status: document.getElementById("status"),
    stockCount: document.getElementById("stock-count"),
    stockPile: document.getElementById("stock-pile"),
    tableau: document.getElementById("tableau"),
    timer: document.getElementById("timer"),
    undoBtn: document.getElementById("undo-btn"),
    wastePile: document.getElementById("waste-pile"),
    winMessage: document.getElementById("win-message"),
    winOverlay: document.getElementById("win-overlay"),
  };

  let state = null;
  let selected = null;
  let dragState = null;
  let dragDropTarget = null;
  let history = [];
  let timerId = 0;
  let currentMessage = "Move Aces to the foundations. Build tableau piles downward in alternating colors.";
  let suppressNextClick = false;
  let suppressNextDblClick = false;

  function readSavedDrawMode() {
    const saved = Number(localStorage.getItem(MODE_KEY));
    return saved === 3 ? 3 : 1;
  }

  function bestKey() {
    return `${BEST_KEY_PREFIX}-${state.drawMode}`;
  }

  function readBest() {
    try {
      return JSON.parse(localStorage.getItem(bestKey()));
    } catch (error) {
      return null;
    }
  }

  function saveBestIfNeeded() {
    const best = readBest();
    const isBetter =
      !best ||
      state.seconds < best.seconds ||
      (state.seconds === best.seconds && state.moves < best.moves);

    if (isBetter) {
      localStorage.setItem(
        bestKey(),
        JSON.stringify({
          seconds: state.seconds,
          moves: state.moves,
          date: new Date().toISOString(),
        })
      );
    }

    return isBetter;
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function setMessage(message) {
    currentMessage = message;
    els.message.textContent = message;
  }

  function rejectBoardMoveWhenInactive() {
    if (state?.status === "Playing") return false;

    selected = null;
    setMessage("This deal is complete. Start a new deal to play again.");
    render();
    return true;
  }

  function pushHistory() {
    history.push(Logic.cloneState(state));
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
  }

  function startTimer() {
    window.clearInterval(timerId);
    timerId = window.setInterval(() => {
      if (state && state.status === "Playing") {
        state.seconds += 1;
        renderStats();
      }
    }, 1000);
  }

  function startNewGame(drawMode = readSavedDrawMode()) {
    state = Logic.newGame(drawMode);
    selected = null;
    history = [];
    localStorage.setItem(MODE_KEY, String(drawMode));
    hideWinOverlay();
    setMessage("Move Aces to the foundations. Build tableau piles downward in alternating colors.");
    startTimer();
    render();
  }

  function revealTopTableauCard(pileIndex) {
    const pile = state.tableau[pileIndex];
    const card = Logic.topCard(pile);
    if (card && !card.faceUp) {
      card.faceUp = true;
      return true;
    }
    return false;
  }

  function getSelectedCards() {
    if (!selected) return [];

    if (selected.source === "waste") {
      const card = Logic.topCard(state.waste);
      return card ? [card] : [];
    }

    if (selected.source === "foundation") {
      const card = Logic.topCard(state.foundations[selected.suit]);
      return card ? [card] : [];
    }

    if (selected.source === "tableau") {
      return state.tableau[selected.pile].slice(selected.index);
    }

    return [];
  }

  function removeSelectedCards() {
    if (selected.source === "waste") {
      return [state.waste.pop()];
    }

    if (selected.source === "foundation") {
      return [state.foundations[selected.suit].pop()];
    }

    const cards = state.tableau[selected.pile].splice(selected.index);
    revealTopTableauCard(selected.pile);
    return cards;
  }

  function sameSelection(source, pile, index, suit) {
    return (
      selected &&
      selected.source === source &&
      selected.pile === pile &&
      selected.index === index &&
      selected.suit === suit
    );
  }

  function selectSource(source, pile = null, index = null, suit = null) {
    if (rejectBoardMoveWhenInactive()) return;

    if (source === "waste") {
      const card = Logic.topCard(state.waste);
      if (!card) {
        setMessage("The waste pile is empty. Draw from the stock first.");
        return;
      }
      selected = { source, pile: null, index: null, suit: null };
      setMessage(`Selected ${Logic.cardLabel(card)}.`);
      render();
      return;
    }

    if (source === "foundation") {
      const card = Logic.topCard(state.foundations[suit]);
      if (!card) {
        setMessage("That foundation is empty.");
        return;
      }
      selected = { source, pile: null, index: null, suit };
      setMessage(`Selected ${Logic.cardLabel(card)} from the foundation.`);
      render();
      return;
    }

    const pileCards = state.tableau[pile];
    const card = pileCards[index];
    const movingCards = pileCards.slice(index);

    if (!card || !card.faceUp) {
      setMessage("Face-down cards are revealed by clearing the cards above them.");
      return;
    }

    if (!Logic.canMoveRun(movingCards)) {
      setMessage("That stack is not in descending alternating order yet.");
      return;
    }

    selected = { source, pile, index, suit: null };
    setMessage(`Selected ${Logic.cardLabel(card)}${movingCards.length > 1 ? " stack" : ""}.`);
    render();
  }

  function clearSelection(message = "Selection cleared.") {
    selected = null;
    setMessage(message);
    render();
  }

  function setSelectedSource(sourceInfo) {
    selected = {
      source: sourceInfo.source,
      pile: sourceInfo.pile,
      index: sourceInfo.index,
      suit: sourceInfo.suit,
    };
  }

  function finishMove(message) {
    selected = null;
    state.moves += 1;

    if (Logic.isWon(state)) {
      state.status = "Won";
      state.won = true;
      const newBest = saveBestIfNeeded();
      setMessage(newBest ? "You won and set a new best time." : "You won Solitaire.");
      showWinOverlay(newBest);
    } else {
      setMessage(message);
    }

    render();
  }

  function attemptMoveSelectedToTableau(pileIndex) {
    if (rejectBoardMoveWhenInactive()) return;

    if (!selected) {
      setMessage("Select a face-up card first.");
      return;
    }

    if (selected.source === "tableau" && selected.pile === pileIndex) {
      clearSelection("Selection cleared.");
      return;
    }

    const movingCards = getSelectedCards();
    const destinationPile = state.tableau[pileIndex];
    if (!Logic.canPlaceOnTableau(movingCards, destinationPile)) {
      const firstCard = movingCards[0];
      setMessage(
        firstCard && firstCard.rank === 13
          ? "Kings can move to empty tableau spaces."
          : "Tableau moves must descend and alternate colors."
      );
      return;
    }

    pushHistory();
    const cards = removeSelectedCards();
    destinationPile.push(...cards);
    finishMove(`Moved ${Logic.cardLabel(cards[0])} to tableau pile ${pileIndex + 1}.`);
  }

  function attemptMoveSelectedToFoundation(suit) {
    if (rejectBoardMoveWhenInactive()) return;

    if (!selected) {
      setMessage("Select a single face-up card first.");
      return;
    }

    if (selected.source === "foundation" && selected.suit === suit) {
      clearSelection("Selection cleared.");
      return;
    }

    const movingCards = getSelectedCards();
    const card = movingCards[0];
    if (movingCards.length !== 1 || !card) {
      setMessage("Only one card at a time can move to a foundation.");
      return;
    }

    if (card.suit !== suit || !Logic.canPlaceOnFoundation(card, state.foundations[suit])) {
      setMessage("Foundations build from Ace to King by matching suit.");
      return;
    }

    pushHistory();
    removeSelectedCards();
    card.faceUp = true;
    state.foundations[suit].push(card);
    finishMove(`Moved ${Logic.cardLabel(card)} to the ${Logic.SUIT_NAMES[suit]} foundation.`);
  }

  function canMoveSelectedToDropTarget(dropTarget) {
    if (!selected || !dropTarget) return false;

    const movingCards = getSelectedCards();
    if (dropTarget.target === "tableau") {
      if (selected.source === "tableau" && selected.pile === dropTarget.pile) return false;
      return Logic.canPlaceOnTableau(movingCards, state.tableau[dropTarget.pile]);
    }

    if (dropTarget.target === "foundation") {
      const card = movingCards[0];
      return (
        movingCards.length === 1 &&
        card?.suit === dropTarget.suit &&
        Logic.canPlaceOnFoundation(card, state.foundations[dropTarget.suit])
      );
    }

    return false;
  }

  function moveSelectedToDropTarget(dropTarget) {
    if (!dropTarget) return false;

    if (dropTarget.target === "tableau") {
      attemptMoveSelectedToTableau(dropTarget.pile);
      return true;
    }

    if (dropTarget.target === "foundation") {
      attemptMoveSelectedToFoundation(dropTarget.suit);
      return true;
    }

    return false;
  }

  function drawFromStock() {
    if (state.status !== "Playing") return;

    selected = null;

    if (state.stock.length === 0) {
      if (state.waste.length === 0) {
        setMessage("No cards are left in the stock or waste pile.");
        render();
        return;
      }

      pushHistory();
      state.stock = state.waste
        .slice()
        .reverse()
        .map((card) => ({ ...card, faceUp: false }));
      state.waste = [];
      state.moves += 1;
      setMessage("Recycled the waste pile back into the stock.");
      render();
      return;
    }

    pushHistory();
    const drawCount = Math.min(state.drawMode, state.stock.length);
    for (let index = 0; index < drawCount; index += 1) {
      const card = state.stock.pop();
      card.faceUp = true;
      state.waste.push(card);
    }
    state.moves += 1;
    setMessage(drawCount === 1 ? "Drew one card." : `Drew ${drawCount} cards.`);
    render();
  }

  function undoMove() {
    if (!history.length) {
      setMessage("Nothing to undo yet.");
      return;
    }

    state = history.pop();
    selected = null;
    hideWinOverlay();
    setMessage("Undid the last move.");
    render();
  }

  function findFoundationMove() {
    const wasteCard = Logic.topCard(state.waste);
    if (wasteCard && Logic.canPlaceOnFoundation(wasteCard, state.foundations[wasteCard.suit])) {
      return { source: "waste", suit: wasteCard.suit };
    }

    for (let pile = 0; pile < state.tableau.length; pile += 1) {
      const card = Logic.topCard(state.tableau[pile]);
      if (card && Logic.canPlaceOnFoundation(card, state.foundations[card.suit])) {
        return { source: "tableau", pile, index: state.tableau[pile].length - 1, suit: card.suit };
      }
    }

    return null;
  }

  function autoMoveToFoundations() {
    if (state.status !== "Playing") return;

    let move = findFoundationMove();
    if (!move) {
      setMessage("No foundation moves are available right now.");
      render();
      return;
    }

    pushHistory();
    let moved = 0;
    while (move && moved < 52) {
      selected = {
        source: move.source,
        pile: move.pile ?? null,
        index: move.index ?? null,
        suit: move.source === "foundation" ? move.suit : null,
      };
      const card = getSelectedCards()[0];
      removeSelectedCards();
      card.faceUp = true;
      state.foundations[card.suit].push(card);
      moved += 1;
      move = findFoundationMove();
    }

    selected = null;
    state.moves += moved;

    if (Logic.isWon(state)) {
      state.status = "Won";
      state.won = true;
      const newBest = saveBestIfNeeded();
      showWinOverlay(newBest);
      setMessage(newBest ? "Auto-move finished the game with a new best." : "Auto-move finished the game.");
    } else {
      setMessage(`Moved ${moved} card${moved === 1 ? "" : "s"} to the foundations.`);
    }

    render();
  }

  function findHint() {
    const wasteCard = Logic.topCard(state.waste);
    if (wasteCard) {
      if (Logic.canPlaceOnFoundation(wasteCard, state.foundations[wasteCard.suit])) {
        return `Move ${Logic.cardLabel(wasteCard)} from waste to its foundation.`;
      }

      for (let pile = 0; pile < state.tableau.length; pile += 1) {
        if (Logic.canPlaceOnTableau([wasteCard], state.tableau[pile])) {
          return `Move ${Logic.cardLabel(wasteCard)} from waste to tableau pile ${pile + 1}.`;
        }
      }
    }

    for (let sourcePile = 0; sourcePile < state.tableau.length; sourcePile += 1) {
      const sourceCards = state.tableau[sourcePile];
      const top = Logic.topCard(sourceCards);
      if (top && Logic.canPlaceOnFoundation(top, state.foundations[top.suit])) {
        return `Move ${Logic.cardLabel(top)} from tableau pile ${sourcePile + 1} to its foundation.`;
      }
    }

    for (let sourcePile = 0; sourcePile < state.tableau.length; sourcePile += 1) {
      const sourceCards = state.tableau[sourcePile];
      for (let index = 0; index < sourceCards.length; index += 1) {
        const movingCards = sourceCards.slice(index);
        if (!Logic.canMoveRun(movingCards)) continue;

        for (let targetPile = 0; targetPile < state.tableau.length; targetPile += 1) {
          if (targetPile === sourcePile) continue;
          if (Logic.canPlaceOnTableau(movingCards, state.tableau[targetPile])) {
            return `Move ${Logic.cardLabel(movingCards[0])}${movingCards.length > 1 ? " stack" : ""} from pile ${sourcePile + 1} to pile ${targetPile + 1}.`;
          }
        }
      }
    }

    if (state.stock.length > 0) {
      return "Draw from the stock.";
    }

    if (state.waste.length > 0) {
      return "Recycle the waste pile back into the stock.";
    }

    return "No obvious moves remain. Undo a move or start a new deal.";
  }

  function showHint() {
    setMessage(findHint());
  }

  function getCardSourceInfo(cardEl) {
    const source = cardEl.dataset.source;
    if (!source || source === "stock" || cardEl.classList.contains("face-down")) {
      return null;
    }

    const pile = cardEl.dataset.pile ? Number(cardEl.dataset.pile) : null;
    const index = cardEl.dataset.index ? Number(cardEl.dataset.index) : null;
    const suit = cardEl.dataset.suit || null;
    const sourceInfo = { source, pile, index, suit };

    if (source === "waste") {
      return Logic.topCard(state.waste) ? sourceInfo : null;
    }

    if (source === "foundation") {
      return Logic.topCard(state.foundations[suit]) ? sourceInfo : null;
    }

    if (source === "tableau") {
      const movingCards = state.tableau[pile]?.slice(index) || [];
      return Logic.canMoveRun(movingCards) ? sourceInfo : null;
    }

    return null;
  }

  function getDropTargetAt(x, y) {
    const element = document.elementFromPoint(x, y);
    if (!element || !els.board.contains(element)) return null;

    const foundationElement = element.closest("[data-target='foundation'], .card[data-source='foundation']");
    if (foundationElement && els.foundationRow.contains(foundationElement)) {
      return {
        target: "foundation",
        suit: foundationElement.dataset.suit,
        element: foundationElement.closest(".pile-host") || foundationElement,
      };
    }

    const tableauPile = element.closest(".tableau-pile");
    if (tableauPile && els.tableau.contains(tableauPile)) {
      return {
        target: "tableau",
        pile: Number(tableauPile.dataset.pile),
        element: tableauPile,
      };
    }

    const tableauSlot = element.closest("[data-target='tableau']");
    if (tableauSlot) {
      return {
        target: "tableau",
        pile: Number(tableauSlot.dataset.pile),
        element: tableauSlot.closest(".tableau-pile") || tableauSlot,
      };
    }

    return null;
  }

  function clearDragDropTarget() {
    if (dragDropTarget?.element) {
      dragDropTarget.element.classList.remove("drag-over", "drag-over-invalid");
    }
    dragDropTarget = null;
  }

  function updateDragDropTarget(pointerEvent) {
    clearDragDropTarget();

    if (!dragState?.isDragging) return;

    const dropTarget = getDropTargetAt(pointerEvent.clientX, pointerEvent.clientY);
    if (!dropTarget) return;

    setSelectedSource(dragState.sourceInfo);
    const isLegal = canMoveSelectedToDropTarget(dropTarget);
    dropTarget.element.classList.add(isLegal ? "drag-over" : "drag-over-invalid");
    dragDropTarget = dropTarget;
  }

  function getDragCards(sourceInfo) {
    if (sourceInfo.source === "waste") {
      const card = Logic.topCard(state.waste);
      return card ? [card] : [];
    }

    if (sourceInfo.source === "foundation") {
      const card = Logic.topCard(state.foundations[sourceInfo.suit]);
      return card ? [card] : [];
    }

    return state.tableau[sourceInfo.pile].slice(sourceInfo.index);
  }

  function getStackOffset(cardEl) {
    if (cardEl.dataset.source !== "tableau") return 0;

    const nextCard = cardEl.nextElementSibling;
    if (!nextCard?.classList.contains("card")) {
      return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stack-gap")) || 34;
    }

    return Math.max(24, nextCard.getBoundingClientRect().top - cardEl.getBoundingClientRect().top);
  }

  function createDragGhost(cardEl, sourceInfo) {
    const cards = getDragCards(sourceInfo);
    const cardRect = cardEl.getBoundingClientRect();
    const stackOffset = getStackOffset(cardEl);
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.style.width = `${cardRect.width}px`;
    ghost.style.height = `${cardRect.height + Math.max(0, cards.length - 1) * stackOffset}px`;

    cards.forEach((card, index) => {
      const cardClone = createCardButton(card, { source: "drag", extraClass: "drag-card" });
      cardClone.disabled = true;
      cardClone.style.position = "absolute";
      cardClone.style.left = "0";
      cardClone.style.top = `${index * stackOffset}px`;
      cardClone.style.width = `${cardRect.width}px`;
      cardClone.style.height = `${cardRect.height}px`;
      ghost.append(cardClone);
    });

    document.body.append(ghost);
    return ghost;
  }

  function positionDragGhost(clientX, clientY) {
    if (!dragState?.ghost) return;

    dragState.ghost.style.transform = `translate3d(${clientX - dragState.offsetX}px, ${clientY - dragState.offsetY}px, 0)`;
  }

  function beginDragging(pointerEvent) {
    if (!dragState || dragState.isDragging) return;

    dragState.isDragging = true;
    suppressNextClick = true;
    selected = null;
    dragState.sourceCard.classList.add("drag-source");
    dragState.ghost = createDragGhost(dragState.sourceCard, dragState.sourceInfo);
    positionDragGhost(pointerEvent.clientX, pointerEvent.clientY);
    document.body.classList.add("is-card-dragging");
    setMessage("Drag to a tableau pile or foundation.");
  }

  function handleCardPointerDown(event) {
    if (event.button !== 0 || state.status !== "Playing") return;

    const cardEl = event.target.closest(".card");
    if (!cardEl || !els.board.contains(cardEl)) return;

    const sourceInfo = getCardSourceInfo(cardEl);
    if (!sourceInfo) return;

    const rect = cardEl.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      sourceInfo,
      sourceCard: cardEl,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      isDragging: false,
      ghost: null,
    };

    cardEl.setPointerCapture?.(event.pointerId);
  }

  function handleCardPointerMove(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const moved = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
    if (!dragState.isDragging && moved >= 6) {
      beginDragging(event);
    }

    if (!dragState.isDragging) return;

    event.preventDefault();
    positionDragGhost(event.clientX, event.clientY);
    updateDragDropTarget(event);
  }

  function finishCardPointerDrag(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    const wasDragging = dragState.isDragging;
    if (wasDragging) {
      event.preventDefault();
      setSelectedSource(dragState.sourceInfo);
      const dropTarget = getDropTargetAt(event.clientX, event.clientY);
      if (dropTarget && canMoveSelectedToDropTarget(dropTarget)) {
        moveSelectedToDropTarget(dropTarget);
      } else {
        selected = null;
        setMessage("Card returned. Drop it on a legal tableau pile or foundation.");
        render();
      }
    }

    dragState.sourceCard.releasePointerCapture?.(event.pointerId);
    dragState.sourceCard.classList.remove("drag-source");
    dragState.ghost?.remove();
    document.body.classList.remove("is-card-dragging");
    clearDragDropTarget();
    dragState = null;

    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
  }

  function cancelCardDrag() {
    if (!dragState) return;

    dragState.sourceCard.classList.remove("drag-source");
    dragState.ghost?.remove();
    document.body.classList.remove("is-card-dragging");
    clearDragDropTarget();
    selected = null;
    dragState = null;
    suppressNextClick = false;
    render();
  }

  function autoMoveSource(source, pile = null, index = null, suit = null) {
    if (rejectBoardMoveWhenInactive()) return;

    selected = { source, pile, index, suit };
    const movingCards = getSelectedCards();
    const card = movingCards[0];
    if (!card) {
      selected = null;
      return;
    }

    if (source !== "foundation" && movingCards.length === 1 && Logic.canPlaceOnFoundation(card, state.foundations[card.suit])) {
      attemptMoveSelectedToFoundation(card.suit);
      return;
    }

    for (let targetPile = 0; targetPile < state.tableau.length; targetPile += 1) {
      if (source === "tableau" && pile === targetPile) continue;

      if (Logic.canPlaceOnTableau(movingCards, state.tableau[targetPile])) {
        attemptMoveSelectedToTableau(targetPile);
        return;
      }
    }

    selected = null;
    setMessage(`${Logic.cardLabel(card)} has no automatic move right now.`);
    render();
  }

  function autoMoveCardElement(cardEl) {
    const sourceInfo = getCardSourceInfo(cardEl);
    if (!sourceInfo) {
      selected = null;
      setMessage(
        cardEl.classList.contains("face-down")
          ? "Face-down cards are revealed by clearing the cards above them."
          : "That stack cannot move automatically yet."
      );
      render();
      return;
    }

    autoMoveSource(sourceInfo.source, sourceInfo.pile, sourceInfo.index, sourceInfo.suit);
  }

  function handleCardClick(cardEl) {
    const source = cardEl.dataset.source;
    const pile = cardEl.dataset.pile ? Number(cardEl.dataset.pile) : null;
    const index = cardEl.dataset.index ? Number(cardEl.dataset.index) : null;
    const suit = cardEl.dataset.suit || null;

    if (sameSelection(source, pile, index, suit)) {
      clearSelection("Selection cleared.");
      return;
    }

    if (selected && source === "tableau") {
      attemptMoveSelectedToTableau(pile);
      return;
    }

    if (selected && source === "foundation") {
      attemptMoveSelectedToFoundation(suit);
      return;
    }

    selectSource(source, pile, index, suit);
  }

  function handlePileClick(pileEl) {
    const action = pileEl.dataset.action;
    const target = pileEl.dataset.target;

    if (action === "draw") {
      drawFromStock();
      return;
    }

    if (target === "tableau") {
      attemptMoveSelectedToTableau(Number(pileEl.dataset.pile));
      return;
    }

    if (target === "foundation") {
      attemptMoveSelectedToFoundation(pileEl.dataset.suit);
      return;
    }

    if (target === "waste") {
      setMessage("The waste pile is empty. Draw from the stock first.");
    }
  }

  function updateDrawMode(mode) {
    startNewGame(mode);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  function handleKeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === "d") {
      event.preventDefault();
      drawFromStock();
    } else if (key === "u") {
      event.preventDefault();
      undoMove();
    } else if (key === "h") {
      event.preventDefault();
      showHint();
    } else if (key === "n") {
      event.preventDefault();
      startNewGame(state.drawMode);
    } else if (key === "a") {
      event.preventDefault();
      autoMoveToFoundations();
    } else if (key === "f") {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key === "Escape" && dragState) {
      event.preventDefault();
      cancelCardDrag();
    } else if (event.key === "Escape" && selected) {
      event.preventDefault();
      clearSelection("Selection cleared.");
    }
  }

  function isSelectedCard(source, pile, index, suit) {
    if (!selected || selected.source !== source) return false;

    if (source === "tableau") {
      return selected.pile === pile && index >= selected.index;
    }

    if (source === "foundation") {
      return selected.suit === suit;
    }

    return source === "waste";
  }

  function createCardButton(card, options) {
    const button = document.createElement("button");
    button.type = "button";
    button.draggable = false;
    button.className = `card ${card.faceUp ? Logic.cardColor(card) : "face-down"} ${options.extraClass || ""}`.trim();
    button.dataset.source = options.source;
    button.dataset.card = Logic.cardCode(card);

    if (options.pile !== undefined && options.pile !== null) {
      button.dataset.pile = String(options.pile);
    }
    if (options.index !== undefined && options.index !== null) {
      button.dataset.index = String(options.index);
    }
    if (options.suit) {
      button.dataset.suit = options.suit;
    }

    if (isSelectedCard(options.source, options.pile, options.index, options.suit)) {
      button.classList.add("selected");
    }

    if (!card.faceUp) {
      button.setAttribute("aria-label", "Face-down card");
      const mark = document.createElement("span");
      mark.className = "card-back-mark";
      mark.textContent = "H";
      button.append(mark);
      return button;
    }

    button.setAttribute("aria-label", Logic.cardLabel(card));

    const topCorner = document.createElement("span");
    topCorner.className = "card-corner card-corner-top";

    const topRank = document.createElement("span");
    topRank.textContent = Logic.rankLabel(card.rank);
    const topSuit = document.createElement("span");
    topSuit.textContent = Logic.SUIT_SYMBOLS[card.suit];
    topCorner.append(topRank, topSuit);

    const centerSuit = document.createElement("span");
    centerSuit.className = "card-suit";
    centerSuit.textContent = Logic.SUIT_SYMBOLS[card.suit];

    const bottomCorner = document.createElement("span");
    bottomCorner.className = "card-corner card-corner-bottom";
    const bottomRank = document.createElement("span");
    bottomRank.textContent = Logic.rankLabel(card.rank);
    const bottomSuit = document.createElement("span");
    bottomSuit.textContent = Logic.SUIT_SYMBOLS[card.suit];
    bottomCorner.append(bottomRank, bottomSuit);

    button.append(topCorner, centerSuit, bottomCorner);
    return button;
  }

  function createPileButton(label, detail, options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pile-slot ${options.extraClass || ""}`.trim();

    if (options.action) {
      button.dataset.action = options.action;
    }
    if (options.target) {
      button.dataset.target = options.target;
    }
    if (options.pile !== undefined) {
      button.dataset.pile = String(options.pile);
    }
    if (options.suit) {
      button.dataset.suit = options.suit;
    }

    const labelEl = document.createElement("span");
    labelEl.className = "pile-label";
    labelEl.textContent = label;
    const detailEl = document.createElement("span");
    detailEl.className = "pile-detail";
    detailEl.textContent = detail;
    button.append(labelEl, detailEl);
    button.setAttribute("aria-label", `${label} ${detail}`.trim());
    return button;
  }

  function renderStock() {
    els.stockPile.replaceChildren();

    if (state.stock.length > 0) {
      const back = createCardButton({ suit: "S", rank: 1, faceUp: false }, { source: "stock", extraClass: "stock-card" });
      back.dataset.action = "draw";
      back.setAttribute("aria-label", `Draw from stock. ${state.stock.length} cards remain.`);
      els.stockPile.append(back);
      return;
    }

    const label = state.waste.length > 0 ? "Reset" : "Stock";
    const detail = state.waste.length > 0 ? "Waste" : "Empty";
    els.stockPile.append(createPileButton(label, detail, { action: "draw", extraClass: "stock-empty" }));
  }

  function renderWaste() {
    els.wastePile.replaceChildren();
    const card = Logic.topCard(state.waste);
    if (card) {
      els.wastePile.append(createCardButton(card, { source: "waste", extraClass: "waste-card" }));
      els.wastePile.dataset.count = String(Math.min(3, state.waste.length));
      return;
    }

    delete els.wastePile.dataset.count;
    els.wastePile.append(createPileButton("Waste", "Empty", { target: "waste" }));
  }

  function renderFoundations() {
    els.foundationRow.replaceChildren();
    for (const suit of Logic.SUITS) {
      const card = Logic.topCard(state.foundations[suit]);
      const host = document.createElement("div");
      host.className = "pile-host";

      if (card) {
        host.append(createCardButton(card, { source: "foundation", suit }));
      } else {
        host.append(
          createPileButton(Logic.SUIT_SYMBOLS[suit], "A", {
            target: "foundation",
            suit,
            extraClass: Logic.isRedSuit(suit) ? "red-suit" : "black-suit",
          })
        );
      }

      els.foundationRow.append(host);
    }
  }

  function renderTableau() {
    els.tableau.replaceChildren();
    state.tableau.forEach((pile, pileIndex) => {
      const pileEl = document.createElement("div");
      pileEl.className = "tableau-pile";
      pileEl.dataset.pile = String(pileIndex);

      if (pile.length === 0) {
        pileEl.append(createPileButton("K", "Open", { target: "tableau", pile: pileIndex, extraClass: "tableau-empty" }));
      } else {
        pile.forEach((card, cardIndex) => {
          pileEl.append(
            createCardButton(card, {
              source: "tableau",
              pile: pileIndex,
              index: cardIndex,
              extraClass: "tableau-card",
            })
          );
        });
      }

      els.tableau.append(pileEl);
    });
  }

  function renderStats() {
    els.timer.textContent = formatTime(state.seconds);
    els.moves.textContent = String(state.moves);
    els.stockCount.textContent = String(state.stock.length);
    els.status.textContent = state.status;
    els.modeEyebrow.textContent = state.drawMode === 3 ? "Draw Three" : "Draw One";

    const best = readBest();
    els.bestScore.textContent = best ? `Best ${formatTime(best.seconds)} / ${best.moves}` : "Best -";
  }

  function renderFoundationStatus() {
    els.foundationStatus.replaceChildren();
    for (const suit of Logic.SUITS) {
      const row = document.createElement("div");
      row.className = "foundation-chip";

      const suitEl = document.createElement("span");
      suitEl.className = Logic.isRedSuit(suit) ? "suit-red" : "suit-black";
      suitEl.textContent = Logic.SUIT_SYMBOLS[suit];

      const label = document.createElement("span");
      label.textContent = Logic.SUIT_NAMES[suit];

      const count = document.createElement("span");
      count.className = "foundation-count";
      count.textContent = `${state.foundations[suit].length}/13`;

      row.append(suitEl, label, count);
      els.foundationStatus.append(row);
    }
  }

  function renderControls() {
    const isDrawThree = state.drawMode === 3;
    els.drawOneBtn.classList.toggle("active", !isDrawThree);
    els.drawOneBtn.setAttribute("aria-pressed", String(!isDrawThree));
    els.drawThreeBtn.classList.toggle("active", isDrawThree);
    els.drawThreeBtn.setAttribute("aria-pressed", String(isDrawThree));
    els.undoBtn.disabled = history.length === 0;
  }

  function render() {
    renderStats();
    renderControls();
    renderStock();
    renderWaste();
    renderFoundations();
    renderTableau();
    renderFoundationStatus();
  }

  function showWinOverlay(newBest) {
    els.winMessage.textContent = `${formatTime(state.seconds)} with ${state.moves} moves.${newBest ? " New best." : ""}`;
    els.winOverlay.classList.remove("hidden");
  }

  function hideWinOverlay() {
    els.winOverlay.classList.add("hidden");
  }

  function renderGameToText() {
    const tableau = state.tableau.map((pile) => pile.map((card) => (card.faceUp ? Logic.cardCode(card) : "XX")));
    const selectedCards = getSelectedCards().map(Logic.cardCode);
    return JSON.stringify({
      coordinate_system: "Klondike DOM piles: stock, waste, foundations S/H/D/C, tableau piles 0-6 listed top-to-bottom.",
      status: state.status,
      drawMode: state.drawMode,
      seconds: state.seconds,
      moves: state.moves,
      stockCount: state.stock.length,
      wasteTop: Logic.cardCode(Logic.topCard(state.waste)),
      foundationSummary: Logic.foundationSummary(state.foundations),
      tableau,
      selected,
      selectedCards,
      message: currentMessage,
    });
  }

  function advanceTime(ms) {
    if (state && state.status === "Playing") {
      state.seconds += Math.max(0, Math.floor(ms / 1000));
      renderStats();
    }
  }

  function bindEvents() {
    els.board.addEventListener("pointerdown", handleCardPointerDown);
    els.board.addEventListener("pointermove", handleCardPointerMove);
    els.board.addEventListener("pointerup", finishCardPointerDrag);
    els.board.addEventListener("pointercancel", finishCardPointerDrag);

    els.board.addEventListener("click", (event) => {
      if (suppressNextClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const card = event.target.closest(".card");
      if (card && card.dataset.source !== "stock") {
        if (event.detail >= 2) {
          event.preventDefault();
          suppressNextDblClick = true;
          autoMoveCardElement(card);
          window.setTimeout(() => {
            suppressNextDblClick = false;
          }, 0);
          return;
        }

        handleCardClick(card);
        return;
      }

      const pile = event.target.closest(".pile-slot, .stock-card");
      if (pile) {
        handlePileClick(pile);
      }
    });

    els.board.addEventListener("dblclick", (event) => {
      if (suppressNextDblClick) {
        event.preventDefault();
        return;
      }

      const card = event.target.closest(".card");
      if (!card || card.dataset.source === "stock") return;

      autoMoveCardElement(card);
    });

    els.drawBtn.addEventListener("click", drawFromStock);
    els.undoBtn.addEventListener("click", undoMove);
    els.autoBtn.addEventListener("click", autoMoveToFoundations);
    els.hintBtn.addEventListener("click", showHint);
    els.newGameBtn.addEventListener("click", () => startNewGame(state.drawMode));
    els.playAgainBtn.addEventListener("click", () => startNewGame(state.drawMode));
    els.closeWinBtn.addEventListener("click", hideWinOverlay);
    els.drawOneBtn.addEventListener("click", () => updateDrawMode(1));
    els.drawThreeBtn.addEventListener("click", () => updateDrawMode(3));
    document.addEventListener("keydown", handleKeydown);
  }

  bindEvents();
  startNewGame(readSavedDrawMode());

  window.render_game_to_text = renderGameToText;
  window.advanceTime = advanceTime;
})();
