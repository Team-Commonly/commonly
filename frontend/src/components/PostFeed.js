import React, { useEffect, useState } from 'react';
import axios from 'axios';

const PostFeed = () => {
    const [posts, setPosts] = useState([]);

    useEffect(() => {
        const fetchPosts = async () => {
        const res = await axios.get('http://localhost:5000/api/posts');
        setPosts(res.data);
        };
        fetchPosts();
    }, []);

    return (
        <div>
        {posts.map((post) => (
            <div key={post._id}>
            <h3>{post.userId.username}</h3>
            <p>{post.content}</p>
            </div>
        ))}
        </div>
    );
};

export default PostFeed;
