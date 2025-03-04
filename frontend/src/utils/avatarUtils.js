// Avatar options with different colors and styles
export const avatarOptions = [
    { id: 'default', color: 'primary.main' },
    { id: 'red', color: '#e53935' },
    { id: 'purple', color: '#8e24aa' },
    { id: 'blue', color: '#1e88e5' },
    { id: 'teal', color: '#00897b' },
    { id: 'green', color: '#43a047' },
    { id: 'orange', color: '#fb8c00' },
    { id: 'brown', color: '#6d4c41' },
    { id: 'gray', color: '#757575' }
];

// Get the color for an avatar based on its ID
export const getAvatarColor = (avatarId) => {
    const avatar = avatarOptions.find(option => option.id === avatarId);
    return avatar ? avatar.color : 'primary.main';
}; 