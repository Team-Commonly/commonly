import React from 'react';
import { useParams } from 'react-router-dom';
import ChatRoom from './ChatRoom';
import ProjectPodRoom from './ProjectPodRoom';

export default function PodRoomRouter(): React.ReactElement {
  const { podType } = useParams<{ podType?: string }>();

  if (podType === 'project') {
    return <ProjectPodRoom />;
  }

  return <ChatRoom />;
}
