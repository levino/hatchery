package drone

import (
	"context"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/client"
)

// NewClient creates a Docker client from the environment.
func NewClient() (*client.Client, error) {
	return client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
}

// ListDrones returns all containers with the hatchery.managed label.
func ListDrones(ctx context.Context, cli *client.Client) ([]Drone, error) {
	f := filters.NewArgs()
	f.Add("label", LabelManaged+"=true")

	containers, err := cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: f,
	})
	if err != nil {
		return nil, err
	}

	drones := make([]Drone, 0, len(containers))
	for _, c := range containers {
		drones = append(drones, Drone{
			Name:  c.Labels[LabelDrone],
			Repo:  c.Labels[LabelRepo],
			ID:    c.ID,
			State: c.State,
		})
	}
	return drones, nil
}

// FindDrone finds a specific drone by name.
func FindDrone(ctx context.Context, cli *client.Client, name string) (*Drone, error) {
	f := filters.NewArgs()
	f.Add("label", LabelManaged+"=true")
	f.Add("label", LabelDrone+"="+name)

	containers, err := cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: f,
	})
	if err != nil {
		return nil, err
	}
	if len(containers) == 0 {
		return nil, nil
	}

	c := containers[0]
	return &Drone{
		Name:  c.Labels[LabelDrone],
		Repo:  c.Labels[LabelRepo],
		ID:    c.ID,
		State: c.State,
	}, nil
}

// StopDrone stops a running drone.
func StopDrone(ctx context.Context, cli *client.Client, id string) error {
	return cli.ContainerStop(ctx, id, container.StopOptions{})
}

// StartDrone starts a stopped drone.
func StartDrone(ctx context.Context, cli *client.Client, id string) error {
	return cli.ContainerStart(ctx, id, container.StartOptions{})
}

// RemoveDrone force-removes a drone container.
func RemoveDrone(ctx context.Context, cli *client.Client, id string) error {
	return cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
}
