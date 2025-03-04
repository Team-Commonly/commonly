const Post = require('../models/Post');

exports.createPost = async (req, res) => {
    const { content, image, tags } = req.body;
    try {
        const post = new Post({ userId: req.userId, content, image, tags });
        await post.save();
        res.status(201).json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Get user statistics (post count and comment count)
exports.getUserStats = async (req, res) => {
    try {
        const userId = req.params.userId;
        const postCount = await Post.getPostCount(userId);
        const commentCount = await Post.getCommentCount(userId);
        res.json({ postCount, commentCount });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Search posts by content or tags
exports.searchPosts = async (req, res) => {
    try {
        const { query, tags } = req.query;
        let searchQuery = {};

        if (query) {
            searchQuery.$or = [
                { content: { $regex: query, $options: 'i' } },
                { 'comments.text': { $regex: query, $options: 'i' } }
            ];
        }

        if (tags) {
            const tagArray = tags.split(',').map(tag => tag.trim());
            searchQuery.tags = { $in: tagArray };
        }

        const posts = await Post.find(searchQuery)
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture')
            .populate('likedBy', '_id')
            .sort({ createdAt: -1 });

        res.json(posts);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

exports.getPosts = async (_, res) => {
    try {
        const posts = await Post.find()
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture')
            .populate('likedBy', '_id');
        res.json(posts);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// New method to get a single post by ID
exports.getPostById = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id)
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture')
            .populate('likedBy', '_id');
        if (!post) return res.status(404).json({ error: 'Post not found' });
        res.json(post);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Add a comment to a post
exports.addComment = async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Comment text is required' });
        }
        
        const post = await Post.findById(req.params.id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Create the comment object
        const comment = {
            userId: req.userId,
            text,
            createdAt: new Date()
        };
        
        // Add the comment to the post's comments array
        post.comments.push(comment);
        
        // Save the updated post
        await post.save();
        
        // Populate the user information for the new comment and return it
        const updatedPost = await Post.findById(post._id)
            .populate('userId', 'username profilePicture')
            .populate('comments.userId', 'username profilePicture');
        
        // Return only the newly added comment with populated user information
        const newComment = updatedPost.comments[updatedPost.comments.length - 1];
        res.status(201).json(newComment);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Like a post
exports.likePost = async (req, res) => {
    try {
        const postId = req.params.id;
        const userId = req.userId;
        
        const post = await Post.findById(postId);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Check if user has already liked this post
        const userLikedIndex = post.likedBy ? post.likedBy.indexOf(userId) : -1;
        
        if (userLikedIndex === -1) {
            // User hasn't liked the post yet, add like
            if (!post.likedBy) {
                post.likedBy = [];
            }
            post.likedBy.push(userId);
            post.likes += 1;
        } else {
            // User already liked the post, remove like
            post.likedBy.splice(userLikedIndex, 1);
            post.likes = Math.max(0, post.likes - 1);
        }
        
        await post.save();
        res.json({ likes: post.likes, liked: userLikedIndex === -1 });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// Delete a post
exports.deletePost = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Check if the user is the owner of the post
        if (post.userId.toString() !== req.userId) {
            return res.status(403).json({ error: 'You are not authorized to delete this post' });
        }
        
        await Post.findByIdAndDelete(req.params.id);
        res.json({ message: 'Post deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Delete a comment
exports.deleteComment = async (req, res) => {
    try {
        const { id, commentId } = req.params;
        
        const post = await Post.findById(id);
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        // Find the comment index
        const commentIndex = post.comments.findIndex(comment => comment._id.toString() === commentId);
        
        if (commentIndex === -1) {
            return res.status(404).json({ error: 'Comment not found' });
        }
        
        // Check if the user is the owner of the comment
        if (post.comments[commentIndex].userId.toString() !== req.userId) {
            return res.status(403).json({ error: 'You are not authorized to delete this comment' });
        }
        
        // Remove the comment using splice
        post.comments.splice(commentIndex, 1);
        await post.save();
        
        res.json({ message: 'Comment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};