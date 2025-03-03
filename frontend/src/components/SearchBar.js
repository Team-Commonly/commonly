import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { debounce } from 'lodash';
import { Button } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import './SearchBar.css';

const SearchBar = ({ onSearchResults }) => {
    const [query, setQuery] = useState('');
    const [tags, setTags] = useState('');

    const performSearch = async (searchQuery, searchTags) => {
        try {
            const params = {};
            if (searchQuery) params.query = searchQuery;
            if (searchTags) params.tags = searchTags;

            const response = await axios.get('/api/posts/search', { params });
            if (typeof onSearchResults === 'function') {
                onSearchResults(response.data);
            } else {
                console.warn('onSearchResults is not a function');
            }
        } catch (err) {
            console.error('Search failed:', err);
            // If search fails, fetch all posts
            fetchAllPosts();
        }
    };

    const fetchAllPosts = async () => {
        try {
            const response = await axios.get('/api/posts', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            onSearchResults(response.data);
        } catch (err) {
            console.error('Failed to fetch posts:', err);
            onSearchResults([]);
        }
    };

    // Fetch all posts when component mounts
    useEffect(() => {
        fetchAllPosts();
    }, []);

    // Debounced search function
    const debouncedSearch = useCallback(
        debounce((searchQuery, searchTags) => {
            if (!searchQuery && !searchTags) {
                fetchAllPosts();
            } else {
                performSearch(searchQuery, searchTags);
            }
        }, 500),
        []
    );

    const handleSearch = (e) => {
        const value = e.target.value;
        setQuery(value);
        debouncedSearch(value, tags);
    };

    const handleTagsChange = (e) => {
        const value = e.target.value;
        setTags(value);
        debouncedSearch(query, value);
    };

    const handleSearchClick = () => {
        if (!query && !tags) {
            fetchAllPosts();
        } else {
            performSearch(query, tags);
        }
    };

    return (
        <div className="search-bar">
            <div className="search-inputs">
                <input
                    type="text"
                    placeholder="Search posts and comments..."
                    value={query}
                    onChange={handleSearch}
                    className="search-input"
                />
                <input
                    type="text"
                    placeholder="Tags (comma separated)"
                    value={tags}
                    onChange={handleTagsChange}
                    className="tags-input"
                />
                <Button
                    variant="contained"
                    color="primary"
                    onClick={handleSearchClick}
                    className="search-button"
                    startIcon={<SearchIcon />}
                >
                    Search
                </Button>
            </div>
        </div>
    );
};

export default SearchBar;