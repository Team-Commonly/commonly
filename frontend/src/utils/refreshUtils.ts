export const refreshPage = (delay = 100): void => {
  setTimeout(() => {
    window.location.reload();
  }, delay);
};

export const multipleRefreshes = (delays: number[] = [500, 2000]): void => {
  delays.forEach((delay) => {
    setTimeout(() => {
      window.location.reload();
    }, delay);
  });
};

export const setRefreshFlag = (key = 'needsRefresh', count = 1): void => {
  sessionStorage.setItem(key, count.toString());
};

export const checkAndRefresh = (key = 'needsRefresh'): void => {
  const refreshCount = sessionStorage.getItem(key);

  if (refreshCount && parseInt(refreshCount, 10) > 0) {
    const newCount = parseInt(refreshCount, 10) - 1;
    if (newCount > 0) {
      sessionStorage.setItem(key, newCount.toString());
    } else {
      sessionStorage.removeItem(key);
    }

    setTimeout(() => {
      window.location.reload();
    }, 100);
  }
};
