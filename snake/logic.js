(() => {
  const DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };

  const OPPOSITE = {
    up: "down",
    down: "up",
    left: "right",
    right: "left",
  };

  const GEM_LIFETIME_MS = 8000;    // 8 seconds of real time, speed-independent
  const GEM_SPAWN_CHANCE = 0.45;   // 45% chance to spawn a gem after eating food
  const MAX_GEMS = 2;
  const OBSTACLE_INTERVAL = 5;     // spawn one obstacle every N points
  const MAX_OBSTACLES = 25;
  const BONUS_GEM_POINTS = 5;
  const SHRINK_AMOUNT = 3;
  const MIN_SNAKE_LENGTH = 3;
  const EFFECT_DURATION_MS = 5000;  // 5 seconds of real time, speed-independent
  const MULTIPLIER_FOOD_COUNT = 5;
  const GEM_TYPES = ["bonus", "shrink", "speed", "slow", "multiplier"];

  function createInitialState(options = {}) {
    const gridCols = Number.isFinite(options.gridCols)
      ? options.gridCols
      : Number.isFinite(options.gridSize)
        ? options.gridSize
        : 20;
    const gridRows = Number.isFinite(options.gridRows)
      ? options.gridRows
      : Number.isFinite(options.gridSize)
        ? options.gridSize
        : 20;
    const rng = typeof options.rng === "function" ? options.rng : Math.random;
    const midX = Math.floor(gridCols / 2);
    const midY = Math.floor(gridRows / 2);

    const snake = [
      { x: midX, y: midY },
      { x: midX - 1, y: midY },
      { x: midX - 2, y: midY },
    ];

    const enableGems = options.enableGems === true;
    const wrapAround = options.wrapAround === true;
    const enableObstacles = options.enableObstacles === true;

    return {
      gridCols,
      gridRows,
      snake,
      direction: "right",
      directionQueue: [],
      food: placeFood(gridCols, gridRows, snake, rng),
      gems: [],
      activeEffects: [],
      scoreMultiplier: 1,
      multiplierFoodLeft: 0,
      enableGems,
      wrapAround,
      enableObstacles,
      obstacles: [],
      nextObstacleScore: OBSTACLE_INTERVAL,
      score: 0,
      status: "playing",
      events: [],
    };
  }

  function queueDirection(state, nextDirection) {
    if (!DIRS[nextDirection]) {
      return state;
    }

    const queue = state.directionQueue;
    const last = queue.length > 0 ? queue[queue.length - 1] : state.direction;

    if (nextDirection === last || OPPOSITE[nextDirection] === last) {
      return state;
    }

    if (queue.length >= 2) {
      return state;
    }

    return {
      ...state,
      directionQueue: [...queue, nextDirection],
    };
  }

  function togglePause(state) {
    if (state.status === "playing") {
      return { ...state, status: "paused" };
    }

    if (state.status === "paused") {
      return { ...state, status: "playing" };
    }

    return state;
  }

  function step(state, rng = Math.random) {
    if (state.status !== "playing") {
      return state.events && state.events.length ? { ...state, events: [] } : state;
    }

    const direction = state.directionQueue.length > 0 ? state.directionQueue[0] : state.direction;
    const directionQueue = state.directionQueue.slice(1);
    const delta = DIRS[direction];
    const head = state.snake[0];
    const newHead = { x: head.x + delta.x, y: head.y + delta.y };
    const { gridCols, gridRows } = state;

    // Wall collision or wrap-around
    if (
      newHead.x < 0 ||
      newHead.y < 0 ||
      newHead.x >= gridCols ||
      newHead.y >= gridRows
    ) {
      if (state.wrapAround) {
        newHead.x = (newHead.x + gridCols) % gridCols;
        newHead.y = (newHead.y + gridRows) % gridRows;
      } else {
        return {
          ...state,
          direction,
          directionQueue: [],
          status: "gameover",
          events: [{ type: "gameover" }],
        };
      }
    }

    const hitFood =
      state.food &&
      newHead.x === state.food.x &&
      newHead.y === state.food.y;

    // Obstacle collision
    if (state.obstacles.some((o) => o.x === newHead.x && o.y === newHead.y)) {
      return {
        ...state,
        direction,
        directionQueue: [],
        status: "gameover",
        events: [{ type: "gameover" }],
      };
    }

    // Body collision (exclude tail when not eating, as it will have moved)
    const bodyToCheck = hitFood
      ? state.snake
      : state.snake.slice(0, -1);

    if (bodyToCheck.some((segment) => isSame(segment, newHead))) {
      return {
        ...state,
        direction,
        directionQueue: [],
        status: "gameover",
        events: [{ type: "gameover" }],
      };
    }

    // Remove expired effects (wall-clock based, same pattern as gems)
    const effectNow = Date.now();
    const prevEffectTypes = new Set(state.activeEffects.map((e) => e.type));
    let activeEffects = state.activeEffects.filter((e) => effectNow < e.expiresAt);
    const newEffectTypes = new Set(activeEffects.map((e) => e.type));

    // Build new snake
    let snake;
    let food = state.food;
    let score = state.score;
    let status = state.status;
    let scoreMultiplier = state.scoreMultiplier;
    let multiplierFoodLeft = state.multiplierFoodLeft;
    let obstacles = state.obstacles;
    let nextObstacleScore = state.nextObstacleScore;
    const events = [];

    // Emit effectChange if any effect expired this tick (so main.js can update tick speed)
    if (prevEffectTypes.size !== newEffectTypes.size ||
        [...prevEffectTypes].some((t) => !newEffectTypes.has(t))) {
      events.push({ type: "effectChange" });
    }

    if (hitFood) {
      snake = [newHead, ...state.snake];
      score += scoreMultiplier;
      events.push({ type: "eat", x: newHead.x, y: newHead.y, points: scoreMultiplier });

      if (scoreMultiplier > 1) {
        multiplierFoodLeft -= 1;
        if (multiplierFoodLeft <= 0) {
          scoreMultiplier = 1;
          multiplierFoodLeft = 0;
        }
      }

      if (snake.length === gridCols * gridRows) {
        status = "win";
        food = null;
        events.push({ type: "win" });
      } else {
        food = placeFood(gridCols, gridRows, snake, rng, state.obstacles, state.gems);
      }
    } else {
      snake = [newHead, ...state.snake.slice(0, -1)];
    }

    // Gem collision — check after new snake is built
    const hitGemIndex = state.gems.findIndex(
      (g) => g.x === newHead.x && g.y === newHead.y
    );
    const hitGem = hitGemIndex >= 0 ? state.gems[hitGemIndex] : null;

    // Remove the collected gem
    let gems = state.gems.filter((_, i) => i !== hitGemIndex);

    if (hitGem) {
      events.push({ type: "gem", gemType: hitGem.type, x: hitGem.x, y: hitGem.y });
      if (hitGem.type === "bonus") {
        // Bonus respects current score multiplier
        score += BONUS_GEM_POINTS * scoreMultiplier;
      } else if (hitGem.type === "shrink") {
        // Shrink amount scales with multiplier
        snake = snake.slice(0, Math.max(MIN_SNAKE_LENGTH, snake.length - SHRINK_AMOUNT * scoreMultiplier));
      } else if (hitGem.type === "speed" || hitGem.type === "slow") {
        // Replace any existing speed/slow effect; duration is real-time based
        activeEffects = activeEffects.filter(
          (e) => e.type !== "speed" && e.type !== "slow"
        );
        activeEffects = [
          ...activeEffects,
          { type: hitGem.type, expiresAt: Date.now() + EFFECT_DURATION_MS },
        ];
      } else if (hitGem.type === "multiplier") {
        // Stack: each new 2× gem doubles the current multiplier and adds more food
        scoreMultiplier = scoreMultiplier <= 1 ? 2 : scoreMultiplier * 2;
        multiplierFoodLeft += MULTIPLIER_FOOD_COUNT;
      }
    }

    // Remove expired gems (lifetime is wall-clock based, not tick-based)
    const now = Date.now();
    gems = gems.filter((g) => g.expiresAt > now);

    // Try to spawn a gem when food was just eaten (Advanced mode only)
    if (hitFood && status === "playing" && state.enableGems) {
      gems = trySpawnGem(gridCols, gridRows, snake, food, gems, rng);
    }

    // Spawn an obstacle at each score milestone (Advanced mode only)
    if (hitFood && status === "playing" && state.enableObstacles && score >= nextObstacleScore && obstacles.length < MAX_OBSTACLES) {
      const pos = placeObstacle(gridCols, gridRows, snake, food, gems, obstacles, rng);
      if (pos) {
        obstacles = [...obstacles, pos];
        nextObstacleScore += OBSTACLE_INTERVAL;
      }
    }

    return {
      ...state,
      snake,
      direction,
      directionQueue,
      food,
      gems,
      activeEffects,
      scoreMultiplier,
      multiplierFoodLeft,
      obstacles,
      nextObstacleScore,
      score,
      status,
      events,
    };
  }

  function trySpawnGem(gridCols, gridRows, snake, food, gems, rng) {
    if (gems.length >= MAX_GEMS) {
      return gems;
    }

    if (rng() > GEM_SPAWN_CHANCE) {
      return gems;
    }

    const pos = placeGem(gridCols, gridRows, snake, food, gems, rng);
    if (!pos) {
      return gems;
    }

    const type = GEM_TYPES[Math.floor(rng() * GEM_TYPES.length)];
    return [...gems, { ...pos, type, expiresAt: Date.now() + GEM_LIFETIME_MS }];
  }

  // Shared helper: pick a random cell not in `occupied`. Returns {x, y} or null.
  function findAvailableCell(gridCols, gridRows, occupied, rng) {
    const available = gridCols * gridRows - occupied.size;
    if (available <= 0) return null;

    const targetIndex = Math.floor(rng() * available);
    let count = 0;

    for (let y = 0; y < gridRows; y += 1) {
      for (let x = 0; x < gridCols; x += 1) {
        if (!occupied.has(`${x},${y}`)) {
          if (count === targetIndex) return { x, y };
          count += 1;
        }
      }
    }

    return null;
  }

  function placeFood(gridCols, gridRows, snake, rng = Math.random, obstacles = [], gems = []) {
    const occupied = new Set(snake.map((seg) => `${seg.x},${seg.y}`));
    obstacles.forEach((o) => occupied.add(`${o.x},${o.y}`));
    gems.forEach((g) => occupied.add(`${g.x},${g.y}`));
    return findAvailableCell(gridCols, gridRows, occupied, rng);
  }

  function placeGem(gridCols, gridRows, snake, food, gems, rng) {
    const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
    if (food) occupied.add(`${food.x},${food.y}`);
    gems.forEach((g) => occupied.add(`${g.x},${g.y}`));
    return findAvailableCell(gridCols, gridRows, occupied, rng);
  }

  function placeObstacle(gridCols, gridRows, snake, food, gems, obstacles, rng) {
    const occupied = new Set(snake.map((s) => `${s.x},${s.y}`));
    if (food) occupied.add(`${food.x},${food.y}`);
    gems.forEach((g) => occupied.add(`${g.x},${g.y}`));
    obstacles.forEach((o) => occupied.add(`${o.x},${o.y}`));

    // Keep a 2-cell buffer around the snake head to avoid instant death
    const head = snake[0];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        occupied.add(`${head.x + dx},${head.y + dy}`);
      }
    }

    return findAvailableCell(gridCols, gridRows, occupied, rng);
  }

  function isSame(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  window.SnakeLogic = {
    createInitialState,
    queueDirection,
    step,
    placeFood,
    togglePause,
  };
})();
