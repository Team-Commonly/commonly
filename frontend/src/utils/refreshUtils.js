/**
 * Utility functions for handling page refreshes
 */

/**
 * Trigger a full page refresh after a specified delay
 * @param {number} delay - Delay in milliseconds before refreshing
 */
export const refreshPage = (delay = 100) => {
    setTimeout(() => {
        window.location.reload();
    }, delay);
};

/**
 * Trigger multiple page refreshes with specified delays
 * @param {Array<number>} delays - Array of delays in milliseconds
 */
export const multipleRefreshes = (delays = [500, 2000]) => {
    delays.forEach(delay => {
        setTimeout(() => {
            window.location.reload();
        }, delay);
    });
};

/**
 * Store a flag in session storage to trigger a refresh on next page load
 * @param {string} key - Key to use for the flag
 * @param {number} count - Number of refreshes to trigger
 */
export const setRefreshFlag = (key = 'needsRefresh', count = 1) => {
    sessionStorage.setItem(key, count.toString());
};

/**
 * Check if a refresh is needed and perform it if necessary
 * @param {string} key - Key used for the flag
 */
export const checkAndRefresh = (key = 'needsRefresh') => {
    const refreshCount = sessionStorage.getItem(key);
    
    if (refreshCount && parseInt(refreshCount) > 0) {
        // Decrement the refresh count
        const newCount = parseInt(refreshCount) - 1;
        if (newCount > 0) {
            sessionStorage.setItem(key, newCount.toString());
        } else {
            sessionStorage.removeItem(key);
        }
        
        // Refresh the page after a short delay
        setTimeout(() => {
            window.location.reload();
        }, 100);
    }
}; 